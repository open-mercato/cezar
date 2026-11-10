import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { E2E_CREDENTIAL_NAMES, E2E_SETUP_WORKFLOW_NAME, type E2eCredentialName, type E2eStatus } from '@open-mercato/cezar-contract';
import type { RunRecord } from './runs/store.ts';
import { compileV1, graphToSteps } from './workflows/graph.ts';
import type { WorkflowDef, WorkflowStepDef } from './workflows/types.ts';

/**
 * One-click browser e2e setup (spec `.ai/specs/2026-10-10-e2e-one-click-setup.md`).
 *
 * cezar installs TesterArmy's `e2e` the way it does any other work: as a task in its own
 * worktree, finishing with a branch the user merges (or at the review gate, when it is on). The engine learns nothing about e2e — the setup is an
 * ad-hoc workflow (an agent step that installs and configures, then two check steps that prove
 * it) handed to `startRun`, the same path an approved "(planned)" chain takes. It is never a
 * catalog entry, so a project that never asked for e2e never sees it.
 */

export { E2E_SETUP_WORKFLOW_NAME };

/** Where the setup writes the project's own e2e workflow (committable: `.ai/cezar/workflows/`). */
export const E2E_WORKFLOW_FILE = '.ai/cezar/workflows/implement-and-e2e.yaml';

/** Config files that mean the repo has an `e2e` suite — shared with the planner's detection. */
export const E2E_CONFIG_FILES = ['e2e.config.ts', 'e2e.config.mts', 'e2e.config.js', 'e2e.config.mjs'] as const;

/** The task text of a setup run: what the thread and the run list show. */
export const E2E_SETUP_TASK = 'Set up browser e2e tests (TesterArmy e2e) in this repository';

/**
 * Every `e2e` invocation the setup makes: the repo-pinned binary only (`--no-install` — a bare
 * `npx e2e` with nothing installed would fetch the registry's latest instead of the version the
 * setup pinned) and the vendor's telemetry off, because cezar does not widen network exposure
 * on the user's behalf. The replay cache goes to the project's shared check cache, so a
 * recording made in one task's worktree replays in the next (e2e treats a blank value as unset).
 */
const E2E = 'E2E_TELEMETRY_DISABLED=1 E2E_CACHE_DIR="${CEZ_SHARED_CACHE_DIR:+$CEZ_SHARED_CACHE_DIR/e2e}" npx --no-install e2e';

/** The first `e2e` with the non-interactive `init` flags, `E2E_CACHE_DIR` and `--max-duration`. */
export const E2E_PACKAGE = 'e2e@^0.21.0';

/** Run budgets: one smoke test during setup; a whole suite in the user's tasks (exits 1 on expiry). */
const SMOKE_MAX_DURATION_MS = 300_000;
const SUITE_MAX_DURATION_MS = 900_000;

/** The `init --gateway` that generates the model for a stored key; direct providers have none. */
const INIT_GATEWAYS: Partial<Record<E2eCredentialName, string>> = {
  AI_GATEWAY_API_KEY: 'vercel',
  OPENROUTER_API_KEY: 'openrouter',
};

/** What the configured provider package and model factory are, per stored key name. */
const PROVIDER_HINTS: Record<E2eCredentialName, string> = {
  AI_GATEWAY_API_KEY: "the Vercel AI Gateway — keep the `gateway(...)` model `e2e init` generated (package `ai`)",
  OPENAI_API_KEY: 'OpenAI directly — add `@ai-sdk/openai` as a devDependency and use its `openai(...)` model',
  ANTHROPIC_API_KEY: 'Anthropic directly — add `@ai-sdk/anthropic` as a devDependency and use its `anthropic(...)` model',
  OPENROUTER_API_KEY: "OpenRouter — keep the `openrouter(...)` model `e2e init` generated (package `@openrouter/ai-sdk-provider`)",
};

/** The scaffold command: every wizard answer is a flag (e2e #1114), so nothing is left for the agent to undo. */
export function e2eInitCommand(credentials: readonly E2eCredentialName[]): string {
  const gateway = (credentials[0] && INIT_GATEWAYS[credentials[0]]) ?? 'vercel';
  return `E2E_TELEMETRY_DISABLED=1 npx --yes ${E2E_PACKAGE} init --yes --engine web --gateway ${gateway} --skills .agents/skills,.claude/skills --mcp .mcp.json --install </dev/null`;
}

/**
 * The workflow the setup leaves behind for the user's own tasks: implement, unit-test, then
 * prove it in a browser. `retryOn: [1]` loops on e2e's verdict only (exit 2/3/4 are config,
 * credential and engine failures the coding agent cannot fix — `docs/e2e-verification.md`);
 * an exhausted `--max-duration` also exits 1, so a change that hangs the app loops back too.
 * The setup agent adapts the install and unit-test commands to the project; the rest is fixed.
 */
export const E2E_WORKFLOW_TEMPLATE = `name: implement-and-e2e
description: Implement, unit-test, then prove it in a real browser (set up by cezar).
steps:
  - id: deps
    name: Install
    command: "npm ci --prefer-offline --no-audit"

  - id: implement
    name: Implement
    prompt: |
      {{task}}

      If a browser check fails, read .e2e/summary.md and the pages under
      .e2e/failures/ before changing anything. Use the \`e2e\` skill for anything
      you change under tests/.

  - id: unit
    name: Unit tests
    command: "npm test"
    onFail:
      retry: implement
      max: 2

  - id: browser
    name: Browser e2e
    command: |
      ${E2E} run --reporter list,markdown --max-failures 3 --max-duration ${SUITE_MAX_DURATION_MS}; code=$?
      [ -f .e2e/summary.md ] && cat .e2e/summary.md
      exit $code
    onFail:
      retry: implement
      max: 2
      retryOn: [1]
`;

/**
 * The engine substitutes `{{task}}` in every agent prompt (`applyTemplate`), so the template
 * cannot carry it into the setup prompt verbatim: the agent would write the SETUP task's text
 * into the user's workflow. The prompt carries a placeholder and describes the token in words;
 * the `e2e-list` check (a command, which is never templated) proves the file has it.
 */
const TASK_TOKEN = '{{task}}';
const TASK_PLACEHOLDER = '__CEZAR_TASK_TOKEN__';

/** The setup agent's instructions. `credentials` are NAMES only — the agent never sees a value. */
export function e2eSetupPrompt(credentials: readonly E2eCredentialName[]): string {
  const provider = credentials[0];
  const providerLine = provider
    ? `The project has \`${provider}\` stored for its check steps, so wire the default agent to ${PROVIDER_HINTS[provider]}. Pick the model the provider's section of \`node_modules/e2e/docs/models.mdx\` recommends. Do not read, print or write the key — it reaches the check steps from cezar's secret store, never the repository.`
    : 'No model key is stored yet. Keep the `gateway(...)` model `e2e init` generated; tests without `agent.*` steps run without a key, and the user can add `AI_GATEWAY_API_KEY` in Settings → External integrations → Test frameworks later.';
  return `You are setting up TesterArmy's \`e2e\` (agentic browser end-to-end testing) in this repository, so the user never has to. Work only on test setup — do NOT change application code.

1. Check the toolchain. \`e2e\` needs Node.js ^22.22.3 or >=24.8.0 (\`node --version\`). If this repository has no web application that a browser could open (no dev server or start script), or Node is too old, stop: explain why in one short paragraph and change nothing.

2. Scaffold: \`${e2eInitCommand(credentials)}\` — if the repository already has a \`.cursor/\` directory, append \`,.cursor/mcp.json\` to \`--mcp\`. It never overwrites existing files. It writes \`e2e.config.ts\`, \`tests/example.e2e.ts\`, the \`e2e\` skill (\`.agents/skills/e2e\` and a \`.claude/skills/e2e\` symlink), \`.mcp.json\`, a \`test:e2e\` script, devDependencies and \`.gitignore\` entries, and installs the dependencies with the package manager this repository uses, updating its lockfile.

3. Configure \`e2e.config.ts\` so every task gets its own port (cezar runs tasks in parallel):
   - \`app.url: 'http://127.0.0.1:0'\` — literally \`127.0.0.1\`, never \`localhost\`, which e2e rejects with port 0.
   - \`app.command\`: start THIS project's dev server as \`{ executable, args, env }\` (never a shell string) with the \`{port}\` placeholder, bound to 127.0.0.1 — e.g. Vite \`['run','dev','--','--host','127.0.0.1','--port','{port}','--strictPort']\`, Next.js \`['run','dev','--','-H','127.0.0.1','-p','{port}']\` (and add \`allowedDevOrigins: ['127.0.0.1']\` to the Next config, or the page never hydrates). Pass \`PORT: '{port}'\` in \`env\` too. Raise \`startupTimeout\` if the dev server is slow to start. The app process inherits only PATH, HOME and temp variables: put fixed values in \`env\`, and list variables whose values come from the environment (a database URL, a service secret) in \`inheritEnv\` by name or \`PREFIX_*\` — never \`'*'\`, which e2e rejects because it would hand the app the model keys.
   - Model: ${providerLine}
   - Read \`node_modules/e2e/docs/reference/config.mdx\` for anything not covered here.

4. Replace \`tests/example.e2e.ts\` with \`tests/smoke.e2e.ts\`: open \`/\` and assert something visible that this app actually renders (a heading, the main landmark) using locators only — no \`agent.*\` step, so the smoke test passes without a model key. Leave one commented-out \`agent.act\`/\`agent.assert\` example below it.

5. Prove it locally: \`${E2E} list\` must list the smoke test, and \`${E2E} run --reporter list,markdown\` must pass (a missing browser downloads once on its own). Fix the configuration until both pass.

6. Write \`${E2E_WORKFLOW_FILE}\` with exactly this content, changing only the \`deps\` install command and the \`unit\` test command to what this repository uses (drop the \`unit\` step if it has no unit tests). Replace \`${TASK_PLACEHOLDER}\` with cezar's task token: two opening curly braces, the word \`task\`, two closing curly braces, with no spaces. A check step verifies that token is in the file.

\`\`\`yaml
${E2E_WORKFLOW_TEMPLATE.replaceAll(TASK_TOKEN, TASK_PLACEHOLDER)}\`\`\`

7. Commit everything with the message \`chore: set up e2e browser tests\`. Reply with three short lines: the dev-server command you configured, the model provider, and anything the user still has to do.`;
}

/** The draft PR's title — what the user sees in their PR list. */
export const E2E_SETUP_PR_TITLE = 'chore: set up e2e browser tests (TesterArmy e2e)';

/**
 * The setup chain. The checks re-run what step 5 asked the agent to prove, from the outside,
 * and loop back with the failing output on ANY exit code: unlike a coding task, a config,
 * dependency or app-process error (2/3) is exactly the setup's own work.
 *
 * Then cezar opens the draft PR itself (the `github.draft-pr` node — the same `createDraftPr`
 * the review gate's button uses), so the setup ends with something to merge rather than a branch
 * to go looking for. It is a `version: 2` graph only for that node: the steps compile exactly as
 * a v1 chain would (`compileV1`), and the PR node is spliced in before `end`. A PR that cannot be
 * opened — no `gh`, no remote, offline — still ends the run as a success: e2e works either way,
 * the node's note says why there is no PR, and the header's Draft PR button remains.
 */
export function e2eSetupWorkflow(credentials: readonly E2eCredentialName[]): WorkflowDef {
  const steps: WorkflowStepDef[] = [
    { id: 'setup', name: 'Set up e2e', prompt: e2eSetupPrompt(credentials) },
    {
      id: 'e2e-list',
      name: 'e2e config loads',
      command: `${E2E} list || exit $?\ngrep -qF '${TASK_TOKEN}' ${E2E_WORKFLOW_FILE} || { echo '${E2E_WORKFLOW_FILE}: missing or without the ${TASK_TOKEN} token in its implement step'; exit 1; }`,
      onFail: { retry: 'setup', max: 2 },
    },
    {
      id: 'e2e-smoke',
      name: 'e2e smoke test',
      command: `${E2E} run --reporter list,markdown --max-failures 3 --max-duration ${SMOKE_MAX_DURATION_MS}; code=$?\n[ -f .e2e/summary.md ] && cat .e2e/summary.md\nexit $code`,
      onFail: { retry: 'setup', max: 2 },
    },
  ];
  const graph = compileV1(steps);
  const end = graph.nodes.find((n) => n.type === 'end')!.id;
  const last = graph.edges.find((e) => e.from === 'e2e-smoke.pass' && e.to === end)!;
  last.to = 'pr';
  graph.nodes.push({ id: 'pr', name: 'Open draft PR', type: 'github.draft-pr', title: E2E_SETUP_PR_TITLE });
  graph.edges.push({ from: 'pr.created', to: end }, { from: 'pr.failed', to: end });
  return {
    name: E2E_SETUP_WORKFLOW_NAME,
    description: 'Install and configure TesterArmy e2e, prove it with a smoke test, open a draft PR.',
    source: 'built-in',
    // What a loaded v2 file carries (`load.ts`): the graph's agent/check nodes, for every
    // step-reading path. The executor walks `graph`.
    steps: graphToSteps(graph),
    graph,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The `e2e.config.*` at `repoRoot`, or `null`. */
export async function findE2eConfig(repoRoot: string): Promise<string | null> {
  for (const file of E2E_CONFIG_FILES) {
    if (await exists(join(repoRoot, file))) return file;
  }
  return null;
}

/** Which known model keys are among the secret names a check step can read, in preference order. */
export function e2eCredentialsAmong(names: Iterable<string>): E2eCredentialName[] {
  const have = new Set(names);
  return E2E_CREDENTIAL_NAMES.filter((name) => have.has(name));
}

/** The newest setup run in `runs`, or `undefined`. */
export function latestE2eSetupRun(runs: readonly RunRecord[]): RunRecord | undefined {
  let latest: RunRecord | undefined;
  for (const run of runs) {
    if (run.workflow !== E2E_SETUP_WORKFLOW_NAME) continue;
    if (!latest || run.createdAt > latest.createdAt) latest = run;
  }
  return latest;
}

/** A setup run that has not settled yet — starting a second one would race it. */
export function setupInFlight(run: RunRecord | undefined): boolean {
  return run !== undefined && ['queued', 'running', 'waiting'].includes(run.status);
}

export async function readE2eStatus(
  repoRoot: string,
  runs: readonly RunRecord[],
  checkSecretNames: Iterable<string>,
): Promise<E2eStatus> {
  const setup = latestE2eSetupRun(runs);
  return {
    configFile: await findE2eConfig(repoRoot),
    workflow: await exists(join(repoRoot, E2E_WORKFLOW_FILE)),
    credentials: e2eCredentialsAmong(checkSecretNames),
    setup: setup ? { runId: setup.id, status: setup.status } : null,
  };
}
