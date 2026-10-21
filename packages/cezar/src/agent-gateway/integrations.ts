/**
 * `cezar integrations print <hermes|openclaw> [--skill]` — the exact config a person pastes into
 * Hermes Agent / OpenClaw to (1) let it drive cezar over MCP, (2) receive cezar's alerts, with the
 * absolute path of THIS cezar filled in (spec `.ai/specs/2026-10-21-agent-gateway-integrations.md`).
 *
 * Print-only on purpose: cezar never edits another tool's config (AGENTS.md § Zero config — no
 * file to edit that the user did not choose to edit).
 */
import { DEFAULT_COCKPIT_URL } from '../cockpit-address.ts';

export const INTEGRATION_TARGETS = ['hermes', 'openclaw'] as const;
export type IntegrationTarget = (typeof INTEGRATION_TARGETS)[number];

export interface McpLaunch {
  command: string;
  args: string[];
}

/** How a foreign process starts `cezar mcp`: this node + this entry file, so no PATH assumptions. */
export function resolveMcpLaunch(execPath: string = process.execPath, entry: string | undefined = process.argv[1]): McpLaunch {
  if (entry && /\.[cm]?js$/.test(entry)) return { command: execPath, args: [entry, 'mcp'] };
  return { command: 'cezar', args: ['mcp'] };
}

const SKILL_BODY = `# Driving cezar

cezar is a local cockpit that runs coding-agent tasks (Claude Code, Codex, OpenCode) in isolated git
worktrees. Each task ends at a **review gate**; nothing is merged for you. Use the \`cezar_*\` MCP tools
(or, without MCP, the \`cez\` CLI: \`cez runs list\` with \`CEZ_API_URL=${DEFAULT_COCKPIT_URL}\`).

## When to use it

Use cezar when the user wants code changed in a repository: a fix, a feature, a refactor, a review.
Do not use it for questions you can answer yourself.

## Workflow

1. \`cezar_list_projects\` if the user did not say which repository; pass its id as \`project\`.
2. \`cezar_create_task\` with a self-contained task text (what, where, acceptance criteria). It returns the task id.
3. Do not poll in a tight loop. cezar sends an alert when a task needs input, reaches review or fails;
   otherwise check \`cezar_get_task\` occasionally. Statuses: queued, running, **waiting** (needs the user),
   **review** (changes ready), done, failed, cancelled.
4. **waiting**: \`cezar_get_task\` returns \`question\` (the agent's choices); when there is none, read
   \`lastAgentMessage\` to see what it needs. Ask the user, then send the answer with \`cezar_send_message\`.
   Never invent an answer for the user.
5. **review**: summarise \`lastAgentMessage\` and the branch for the user. Only with their go-ahead call
   \`cezar_open_pr\` (draft by default) or \`cezar_accept_review\`; both complete asynchronously, so check
   \`cezar_get_task\` afterwards for the PR url or \`done\`. To request changes, \`cezar_send_message\`.
6. **failed**: report \`error\` and offer to retry with a clearer task or \`cezar_send_message\`.

## Rules

- Ask the user before opening a PR, accepting a review or cancelling work they started.
- A task id may be shortened to its first 8 characters.
- cezar tasks are slow (minutes). Tell the user the task was started and that you will report back.
`;

const DESCRIPTION = 'Drive the local cezar cockpit: start coding-agent tasks in a repository, check status, answer their questions, open PRs.';

/**
 * Same body for both agents. No `metadata.openclaw.requires.bins`: the MCP launch printed by
 * `cezar integrations print` is an absolute node + entry path, so the skill must stay visible even
 * when `cezar` is not on PATH. `description` is JSON-quoted: it contains ": ", which breaks plain YAML.
 */
export function skillMarkdown(_target: IntegrationTarget): string {
  return `---\nname: cezar\ndescription: ${JSON.stringify(DESCRIPTION)}\n---\n\n${SKILL_BODY}`;
}

export function hermesSnippet(launch: McpLaunch): string {
  return `# Hermes Agent — cezar integration
# Docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
#       https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks

# 1) CONTROL: let Hermes drive cezar. Add to ~/.hermes/config.yaml, then restart Hermes or /reload-mcp.
mcp_servers:
  cezar:
    command: ${JSON.stringify(launch.command)}
    args: ${JSON.stringify(launch.args)}
    env:
      CEZ_API_URL: ${JSON.stringify(DEFAULT_COCKPIT_URL)}
# Hermes on another machine than the cockpit: command: "ssh", args: ["<host>", "cezar", "mcp"]

# 2) ALERTS: a webhook route that forwards cezar alerts to your chat without an LLM turn.
#    In ~/.hermes/.env:
#      WEBHOOK_ENABLED=true
#      WEBHOOK_PORT=8644
#    In ~/.hermes/config.yaml:
platforms:
  webhook:
    extra:
      routes:
        cezar:
          secret: "<a long random string>"        # same value as CEZ_HERMES_WEBHOOK_SECRET
          events: ["cezar.task.needs-input", "cezar.task.review", "cezar.task.failed"]
          prompt: "{message}"
          deliver: telegram                       # or slack, discord, whatsapp, signal, ...
          deliver_extra:
            chat_id: "<your chat id>"
          deliver_only: true                      # no LLM turn: the text is sent as-is

# 3) Point cezar at it (environment of the cezar cockpit process):
#      CEZ_HERMES_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/cezar
#      CEZ_HERMES_WEBHOOK_SECRET=<the same secret>
#    Then verify:  cezar alerts test

# 4) SKILL (optional, teaches Hermes when/how to use the tools):
#      mkdir -p ~/.hermes/skills/cezar
#      cezar integrations print hermes --skill > ~/.hermes/skills/cezar/SKILL.md
#    (PowerShell: create the folder, then  ... --skill | Out-File -Encoding utf8 <path>\\SKILL.md)
# To let Hermes ACT on an alert instead of only relaying it, drop deliver_only and make the prompt
# something like "{message} Ask me what to do." — the cezar_* tools are then available to that turn.
`;
}

export function openclawSnippet(launch: McpLaunch): string {
  const server = JSON.stringify({ command: launch.command, args: launch.args, env: { CEZ_API_URL: DEFAULT_COCKPIT_URL } });
  return `# OpenClaw — cezar integration
# Docs: https://docs.openclaw.ai/cli/mcp/registry
#       https://docs.openclaw.ai/automation/cron-jobs/webhooks

# 1) CONTROL: register cezar as an MCP server OpenClaw agents can call.
openclaw mcp set cezar '${server.replace(/'/g, `'\\''`)}'
# Same thing without JSON quoting (PowerShell / cmd):
openclaw mcp add cezar --command ${launch.command} ${launch.args.map((arg) => `--arg ${arg}`).join(' ')} --env CEZ_API_URL=${DEFAULT_COCKPIT_URL}
openclaw mcp doctor --probe

# 2) SKILL (optional, teaches the agent when/how to use the tools). bash:
mkdir -p ~/.openclaw/skills/cezar
cezar integrations print openclaw --skill > ~/.openclaw/skills/cezar/SKILL.md
#    PowerShell: create the folder, then  ... --skill | Out-File -Encoding utf8 <path>\\SKILL.md

# 3) ALERTS: enable OpenClaw's HTTP hooks in the OpenClaw config (they are off by default), then restart the gateway.
#    Use a token dedicated to hooks, not the gateway token.
#      hooks: { enabled: true, token: "<long random>", path: "/hooks", allowedAgentIds: ["main"] }
#      openclaw config validate && openclaw gateway restart

# 4) Point cezar at it (environment of the cezar cockpit process):
#      CEZ_OPENCLAW_URL=http://127.0.0.1:18789          # gateway; /hooks is appended unless you give a path
#      CEZ_OPENCLAW_HOOK_TOKEN=<the hooks token>
#    Optional — have the agent message you on a channel and be able to answer through the MCP tools
#    (without these, alerts go to /hooks/wake as a system event in the main session):
#      CEZ_OPENCLAW_CHANNEL=telegram                    # a concrete channel: telegram, slack, discord, whatsapp, ...
#      CEZ_OPENCLAW_TO=<recipient on that channel>
#      CEZ_OPENCLAW_AGENT_ID=main
#    Then verify:  cezar alerts test
`;
}

const USAGE = `cezar integrations — config for letting Hermes Agent / OpenClaw drive cezar and receive its alerts

  cezar integrations print <${INTEGRATION_TARGETS.join('|')}>           setup steps and config snippets (paste them yourself)
  cezar integrations print <${INTEGRATION_TARGETS.join('|')}> --skill   the SKILL.md for that agent, to stdout

Nothing is written for you: cezar never edits another tool's config.`;

export function runIntegrationsCommand(args: string[], log: (line: string) => void = console.log): number {
  const [command, target, flag] = args;
  if (command !== 'print' || !(INTEGRATION_TARGETS as readonly string[]).includes(target ?? '')) {
    (command === 'help' || command === '--help' ? log : console.error)(USAGE);
    return command === 'help' || command === '--help' ? 0 : 2;
  }
  const which = target as IntegrationTarget;
  if (flag === '--skill') log(skillMarkdown(which).trimEnd());
  else log((which === 'hermes' ? hermesSnippet(resolveMcpLaunch()) : openclawSnippet(resolveMcpLaunch())).trimEnd());
  return 0;
}
