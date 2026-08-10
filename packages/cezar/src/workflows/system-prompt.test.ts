import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HANDOFF_INSTRUCTIONS, HANDOFF_ONLY_INSTRUCTIONS } from '../handoff.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { WorkflowDef } from './types.ts';
import {
  RunManager,
  composeSystemPrompt,
  makeRunTitle,
  resolveExtraSystemPrompt,
  skillSystemPrompt,
} from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Precedence table (R2 2.3): per-run override REPLACES the config default. */
describe('resolveExtraSystemPrompt', () => {
  it.each([
    ['neither set', undefined, undefined, undefined],
    ['config only', undefined, 'Config prompt', 'Config prompt'],
    ['override only', 'Override prompt', undefined, 'Override prompt'],
    ['both set — override wins outright', 'Override prompt', 'Config prompt', 'Override prompt'],
    ['blank override does not shadow the config default', '   ', 'Config prompt', 'Config prompt'],
    ['override is trimmed', '  Override prompt  ', undefined, 'Override prompt'],
    ['both blank', '', '   ', undefined],
  ] as const)('%s', (_name, override, configDefault, expected) => {
    expect(resolveExtraSystemPrompt(override, configDefault)).toBe(expected);
  });
});

/** Fixed part order: skill body → extra prompt → handoff contract. */
describe('composeSystemPrompt', () => {
  const H = 'HANDOFF CONTRACT';
  it.each([
    ['contract only', [undefined, undefined, H], H],
    ['skill + contract (the pre-2.3 composition, unchanged)', ['SKILL BODY', undefined, H], `SKILL BODY\n\n---\n\n${H}`],
    ['extra + contract', [undefined, 'EXTRA', H], `EXTRA\n\n---\n\n${H}`],
    ['skill + extra + contract', ['SKILL BODY', 'EXTRA', H], `SKILL BODY\n\n---\n\nEXTRA\n\n---\n\n${H}`],
    ['blank parts drop out', ['', '   ', H], H],
  ] as const)('%s', (_name, parts, expected) => {
    expect(composeSystemPrompt(...parts)).toBe(expected);
  });
});

describe('handoff contract markers', () => {
  it('teaches the CEZ:ASK structured-question marker with its schema (#473)', () => {
    expect(HANDOFF_ONLY_INSTRUCTIONS).toContain('CEZ:ASK');
    expect(HANDOFF_ONLY_INSTRUCTIONS).toContain('"questions"');
    expect(HANDOFF_ONLY_INSTRUCTIONS).toContain('"multiSelect"');
    // It rides in the combined contract every agent step receives.
    expect(HANDOFF_INSTRUCTIONS).toContain('CEZ:ASK');
  });
});

describe('skill-aware task naming (#432)', () => {
  const skillWorkflow: WorkflowDef = {
    name: '(planned)',
    source: 'built-in',
    steps: [{ id: 'task', name: 'om-auto-review-pr', skill: 'om-auto-review-pr', prompt: '{{task}}' }],
  };

  it('leads with the number for argument-only tasks (task auto-naming spec)', () => {
    expect(makeRunTitle('432', skillWorkflow)).toBe('432: /om-auto-review-pr');
  });

  it('rewrites a user-supplied skill command with a numeric argument to number-first', () => {
    expect(makeRunTitle('/om-auto-review-pr 432', skillWorkflow)).toBe('432: /om-auto-review-pr');
    // A non-numeric argument keeps the full command, number still leads.
    expect(makeRunTitle('/om-auto-review-pr 432 and check CI', skillWorkflow)).toBe(
      '432: /om-auto-review-pr 432 and check CI',
    );
  });

  it('keeps the legacy task-only fallback when no skill is selected', () => {
    const workflow: WorkflowDef = {
      name: 'quick-task',
      source: 'built-in',
      steps: [{ id: 'task', prompt: '{{task}}' }],
    };
    expect(makeRunTitle('Fix the login bug', workflow)).toBe('Fix the login bug');
    // A referenced PR/issue leads the title even without a skill.
    expect(makeRunTitle('review pr 437 with autofix', workflow)).toBe('437: review pr 437 with autofix');
    // A bare number without a skill stays bare — no `469: 469`.
    expect(makeRunTitle('469', workflow)).toBe('469');
    expect(makeRunTitle('#469', workflow)).toBe('#469');
  });
});

/**
 * End-to-end through the real engine with CEZ_DRY_RUN=1: the config default
 * and the per-run override must reach the claude CLI's argv verbatim
 * (`--append-system-prompt`, captured via the mock's CEZ_MOCK_ARGS_FILE hook)
 * and be echoed on the RunRecord.
 */
describe('systemPrompt end-to-end (dry run)', () => {
  const CONFIG_PROMPT = 'CONFIG-DEFAULT: always write tests first.';
  const OVERRIDE_PROMPT = 'PER-RUN OVERRIDE: answer in bullet points.';
  const SKILL_DESCRIPTION = 'Review a pull request by number and report actionable findings.';
  const SKILL_BODY = 'Inspect the selected pull request and review its diff.';
  let repoRoot: string;
  let argsFile: string;
  let inheritedTodos: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-sysprompt-'));
    argsFile = join(repoRoot, 'mock-args.ndjson');
    inheritedTodos = join(repoRoot, 'inherited-todos.json');
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_ARGS_FILE = process.env.CEZ_MOCK_ARGS_FILE;
    savedEnv.CEZ_TODOS_FILE = process.env.CEZ_TODOS_FILE;
    savedEnv.CEZ_FOLLOWUPS = process.env.CEZ_FOLLOWUPS;
    savedEnv.CEZ_AUTONAME = process.env.CEZ_AUTONAME;
    process.env.CEZ_DRY_RUN = '1';
    // The global inbox is opt-in (#471). These assertions are about prompt composition and the
    // per-run opt-out, so they run on an inbox-enabled server; the gate itself is covered by
    // the suite below.
    process.env.CEZ_FOLLOWUPS = '1';
    // Dry-run skips naming by default (canned titles would clobber honest
    // heuristics in demos/e2e); '1' forces the mock path for these tests.
    process.env.CEZ_AUTONAME = '1';
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
    // Simulate a nested cezar (an agent running `cez serve` / the test suite):
    // the parent process already carries CEZ_TODOS_FILE. Runners spawn with
    // `{ ...process.env, ...spec.env }`, so `agentEnv` must *shadow* this for
    // every run — never merely omit the key — or an opted-out agent writes
    // follow-ups into the parent's inbox. Asserted per test below.
    process.env.CEZ_TODOS_FILE = inheritedTodos;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    mkdirSync(join(repoRoot, '.ai/skills/om-auto-review-pr'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.ai/skills/om-auto-review-pr/SKILL.md'),
      `---\nname: om-auto-review-pr\ndescription: ${SKILL_DESCRIPTION}\n---\n${SKILL_BODY}\n`,
      'utf8',
    );
    writeFileSync(
      join(repoRoot, '.ai/cezar', 'config.json'),
      JSON.stringify({ systemPrompt: CONFIG_PROMPT }),
      'utf8',
    );
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    // Cap 1 (workspace-level since step 2.5) serializes the suite's runs.
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }),
    });
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // Agent step + trailing check so the agent step is non-interactive — the
  // session auto-ends after the mock's turn and the run reaches a terminal
  // status instead of parking at `waiting`.
  const workflow: WorkflowDef = {
    name: 'sysprompt-test',
    source: 'built-in',
    steps: [
      { id: 'work', prompt: '{{task}}' },
      { id: 'verify', command: 'true' },
    ],
  };

  const skillWorkflow: WorkflowDef = {
    name: '(planned)',
    source: 'built-in',
    steps: [
      { id: 'review', name: 'om-auto-review-pr', skill: 'om-auto-review-pr', prompt: '{{task}}' },
      { id: 'verify', command: 'true' },
    ],
  };

  async function runToEnd(
    input: { task: string; systemPrompt?: string; generateFollowups?: boolean },
    selectedWorkflow: WorkflowDef = workflow,
  ): Promise<string> {
    writeFileSync(argsFile, '', 'utf8'); // fresh capture per run
    const record = manager.startRun(selectedWorkflow, input);
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
    return record.id;
  }

  function capturedSystemPrompt(index = 0): string {
    const lines = readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(index);
    const argv = JSON.parse(lines[index] as string) as string[];
    const idx = argv.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    return argv[idx + 1] as string;
  }

  it('no override: the config default reaches the CLI and is echoed on the record', async () => {
    const id = await runToEnd({ task: 'do the thing' });
    const record = store.getRun(id);
    expect(record?.status).toMatch(/^(done|review)$/);
    expect(record?.systemPrompt).toBe(CONFIG_PROMPT);
    const prompt = capturedSystemPrompt();
    // Composition: extra prompt first (no skill on this step), contract last.
    expect(prompt).toBe(composeSystemPrompt(CONFIG_PROMPT, HANDOFF_INSTRUCTIONS));
  }, 30_000);



  it('live refresh: the namer applies turn context through the mock (direct drive)', async () => {
    const record = manager.startRun(skillWorkflow, { task: '437' });
    type NamerSeam = { autoNameRun(id: string, skill: string | undefined, task: string, live?: object): Promise<void> };
    await (manager as unknown as NamerSeam).autoNameRun(record.id, 'om-auto-review-pr', '437', {
      turnText: 'fixed the watchdog race',
      diffStat: '2 files, +10 -3',
    });
    const after = store.getRun(record.id);
    expect(after?.titleSummary).toBe('437: implementing cr fixes');
    expect(after?.titleOrigin).toBe('auto');
    expect(after?.prNumber).toBe(437);
  }, 30_000);

  it('turn-end refresh skips under CEZ_DRY_RUN and when the toggle or ownership forbids it', async () => {
    type Seam = {
      maybeRefreshTitle(id: string, text: string): Promise<void>;
      lastNamerKey: Map<string, string>;
    };
    const seam = manager as unknown as Seam;
    const record = manager.startRun(skillWorkflow, { task: '437' });

    // Dry-run guard (without the CEZ_AUTONAME=1 force): no key is recorded,
    // the namer is never consulted.
    const forced = process.env.CEZ_AUTONAME;
    delete process.env.CEZ_AUTONAME;
    await seam.maybeRefreshTitle(record.id, 'made real progress on the fix');
    expect(seam.lastNamerKey.has(record.id)).toBe(false);
    process.env.CEZ_AUTONAME = forced;

    // Outside dry-run, a fast-failing fake binary guards against real spawns.
    const savedDry = process.env.CEZ_DRY_RUN;
    const savedBin = process.env.CEZ_CLAUDE_BIN;
    const savedToggle = process.env.CEZ_TITLE_UPDATES;
    delete process.env.CEZ_DRY_RUN;
    process.env.CEZ_CLAUDE_BIN = '/nonexistent/cez-test-claude';
    try {
      // Env default OFF → skip before any runner call.
      process.env.CEZ_TITLE_UPDATES = '0';
      await seam.maybeRefreshTitle(record.id, 'more progress');
      expect(seam.lastNamerKey.has(record.id)).toBe(false);

      // Toggle ON but the title is user-owned → skip.
      process.env.CEZ_TITLE_UPDATES = '1';
      store.updateRun(record.id, { title: 'Mine', titleSummary: 'Mine', titleOrigin: 'user' });
      await seam.maybeRefreshTitle(record.id, 'even more progress');
      expect(seam.lastNamerKey.has(record.id)).toBe(false);

      // Namer-owned + toggle ON → the key is recorded (the call itself fails
      // fast on the fake binary and leaves the title as-is), and the SAME
      // inputs never record twice.
      store.updateRun(record.id, { titleOrigin: 'auto' });
      await seam.maybeRefreshTitle(record.id, 'progress worth naming');
      expect(seam.lastNamerKey.get(record.id)).toContain('progress worth naming');
    } finally {
      if (savedDry === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDry;
      if (savedBin === undefined) delete process.env.CEZ_CLAUDE_BIN;
      else process.env.CEZ_CLAUDE_BIN = savedBin;
      if (savedToggle === undefined) delete process.env.CEZ_TITLE_UPDATES;
      else process.env.CEZ_TITLE_UPDATES = savedToggle;
    }
  }, 30_000);

  it('marker declarations outrank the namer (spec 2026-07-18-task-ref-markers)', async () => {
    const record = manager.startRun(skillWorkflow, { task: '437' });
    await manager.recordTurnEnd(record.id, 'Working on it.\nCEZ:PR=500\nCEZ:TITLE=implementing marker refs');
    let after = store.getRun(record.id);
    expect(after?.prNumber).toBe(500);
    expect(after?.titleSummary).toBe('500: implementing marker refs');
    expect(after?.titleOrigin).toBe('marker');
    // A namer answer landing later (mock: "implementing cr fixes" + pr 437)
    // must not displace the agent's own declaration.
    type NamerSeam = { autoNameRun(id: string, skill: string | undefined, task: string, live?: object): Promise<void> };
    await (manager as unknown as NamerSeam).autoNameRun(record.id, 'om-auto-review-pr', '437', {
      turnText: 'fixed the watchdog race',
      diffStat: '2 files, +10 -3',
    });
    after = store.getRun(record.id);
    expect(after?.titleSummary).toBe('500: implementing marker refs');
    expect(after?.titleOrigin).toBe('marker');
    expect(after?.prNumber).toBe(500);
  }, 30_000);

  it('mock:refs end to end: markers set the record, silence the wrong chip, and stay out of the transcript', async () => {
    const id = await runToEnd({ task: 'do the thing mock:refs mock:done' });
    // Settle window for the fire-and-forget turn-end bookkeeping.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const after = store.getRun(id);
    expect(after?.prNumber).toBe(4242);
    expect(after?.issueNumber).toBe(17);
    expect(after?.titleSummary).toBe('4242: implementing marker refs');
    expect(after?.titleOrigin).toBe('marker');
    // The mock's transcript references pull/123, but the agent declared PR
    // 4242 — a contradicting candidate must NOT become the chip (the #777
    // failure class), and the created tier stays empty (nothing was created).
    expect(after?.referencedPullRequestUrl).toBeUndefined();
    expect(after?.pullRequestUrl).toBeUndefined();
    // Marker lines are protocol noise — stripped from persisted v1 text.
    const textEvents = store.readEvents(id).filter((e) => e.type === 'text');
    expect(textEvents.length).toBeGreaterThan(0);
    for (const event of textEvents) {
      expect(String(event.text)).not.toMatch(/^CEZ:(?:PR|ISSUE|TITLE)=/m);
    }
  }, 30_000);

  it('a user rename made before the namer answers is never overwritten', async () => {
    writeFileSync(argsFile, '', 'utf8');
    const record = manager.startRun(skillWorkflow, { task: '437' });
    // What PATCH /api/v1/runs/:id does, synchronously after creation:
    store.updateRun(record.id, { title: 'My name', titleSummary: 'My name', titleOrigin: 'user' });

    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Settle window for the async namer to (not) apply.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const after = store.getRun(record.id);
    expect(after?.titleSummary).toBe('My name');
    expect(after?.titleOrigin).toBe('user');
  }, 30_000);

  it('override: replaces the config default in argv and in the record echo', async () => {
    const id = await runToEnd({ task: 'do the thing', systemPrompt: OVERRIDE_PROMPT });
    const record = store.getRun(id);
    expect(record?.systemPrompt).toBe(OVERRIDE_PROMPT);
    const prompt = capturedSystemPrompt();
    expect(prompt).toBe(composeSystemPrompt(OVERRIDE_PROMPT, HANDOFF_INSTRUCTIONS));
    expect(prompt).not.toContain(CONFIG_PROMPT);
  }, 30_000);

  it('sends skill identity, description, instructions, and numeric task context to the runner', async () => {
    const id = await runToEnd({ task: '432' }, skillWorkflow);
    const record = store.getRun(id);

    expect(record?.title).toBe('432: /om-auto-review-pr');
    // Step-0 extraction persisted the reference (skill-hint → PR).
    expect(record?.prNumber).toBe(432);
    // The fire-and-forget namer replaces the heuristic with the mock's short
    // title (task auto-naming spec) — async, so poll for it.
    const deadline = Date.now() + 15_000;
    while (store.getRun(id)?.titleSummary !== '432: implementing cr fixes') {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const named = store.getRun(id);
    expect(named?.titleSummary).toBe('432: implementing cr fixes');
    expect(named?.titleOrigin).toBe('auto');

    const skillPrompt = skillSystemPrompt({
      name: 'om-auto-review-pr',
      description: SKILL_DESCRIPTION,
      body: SKILL_BODY,
      // The runner passes the full discovered skill, so the prompt carries the
      // absolute path of the installed copy (read from the MAIN repo even in a
      // worktree). Mirror that here so the expected prompt matches.
      path: join(repoRoot, '.ai/skills/om-auto-review-pr/SKILL.md'),
      source: 'ai',
    });
    expect(capturedSystemPrompt()).toBe(
      composeSystemPrompt(skillPrompt, CONFIG_PROMPT, HANDOFF_INSTRUCTIONS),
    );

    // The mock writes the actual first user message it received into the run
    // worktree, proving the argument is still the runner's user prompt rather
    // than being swallowed by title construction.
    const worktreePath = record?.worktreePath;
    if (!worktreePath) throw new Error('run did not create its worktree');
    expect(readFileSync(join(worktreePath, 'notes.md'), 'utf8')).toContain(': 432\n');
  }, 30_000);

  // The positive control for the opt-out test below: without this, mistyping the `!== false`
  // guard would stop every run from producing inbox entries with the whole suite still green.
  // This suite explicitly enables the global inbox in beforeAll (#471).
  it('on an inbox-enabled server the agent gets the run own inbox, never an inherited one', async () => {
    const todosFile = join(repoRoot, '.ai/cezar/todos.json');
    rmSync(todosFile, { force: true });
    rmSync(inheritedTodos, { force: true });
    await runToEnd({ task: 'do the thing with follow-ups' });
    expect(capturedSystemPrompt()).toContain('CEZ_TODOS_FILE');
    expect(existsSync(todosFile)).toBe(true);
    expect(existsSync(inheritedTodos)).toBe(false);
  }, 30_000);

  it('explicit opt-out keeps handoff behavior but removes inbox prompt and environment', async () => {
    const todosFile = join(repoRoot, '.ai/cezar/todos.json');
    rmSync(todosFile, { force: true });
    rmSync(inheritedTodos, { force: true });
    const id = await runToEnd({ task: 'do the thing quietly', generateFollowups: false });
    const record = store.getRun(id);
    expect(record?.generateFollowups).toBe(false);
    expect(capturedSystemPrompt()).toBe(composeSystemPrompt(CONFIG_PROMPT, HANDOFF_ONLY_INSTRUCTIONS));
    expect(capturedSystemPrompt()).not.toContain('CEZ_TODOS_FILE');
    expect(existsSync(todosFile)).toBe(false);
    // The opt-out must survive an inherited CEZ_TODOS_FILE (nested cezar):
    // omitting the key instead of shadowing it leaks into the parent's inbox.
    expect(existsSync(inheritedTodos)).toBe(false);
    expect(readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.handoff.md`), 'utf8')).toContain(
      'mock: implemented the change',
    );

    expect(manager.continueRun(id, { text: 'continue without generating follow-ups' })).toEqual({
      ok: true,
    });
    const deadline = Date.now() + 20_000;
    while (readFileSync(argsFile, 'utf8').trim().split('\n').length < 2) {
      if (Date.now() > deadline) throw new Error('continuation did not start in time');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(capturedSystemPrompt(1)).toBe(
      composeSystemPrompt(CONFIG_PROMPT, HANDOFF_ONLY_INSTRUCTIONS),
    );
    expect(capturedSystemPrompt(1)).not.toContain('CEZ_TODOS_FILE');
    expect(existsSync(todosFile)).toBe(false);
    expect(existsSync(inheritedTodos)).toBe(false);
  }, 30_000);
});

/**
 * The global inbox gate, end-to-end through the real engine (#471).
 *
 * This drives `RunManager` directly — the same door `cezar run` and the inbox's own "▶ Run" use,
 * and the reason the ceiling lives in the manager rather than in the HTTP route. A route-level
 * gate would leave every one of those callers writing todos.json on a server that has the inbox
 * off.
 */
describe('the global follow-up gate (dry run)', () => {
  const CONFIG_PROMPT = 'CONFIG-DEFAULT: always write tests first.';
  let repoRoot: string;
  let argsFile: string;
  let inheritedTodos: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-followup-gate-'));
    argsFile = join(repoRoot, 'mock-args.ndjson');
    inheritedTodos = join(repoRoot, 'inherited-todos.json');
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_ARGS_FILE = process.env.CEZ_MOCK_ARGS_FILE;
    savedEnv.CEZ_TODOS_FILE = process.env.CEZ_TODOS_FILE;
    savedEnv.CEZ_FOLLOWUPS = process.env.CEZ_FOLLOWUPS;
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
    // A parent cezar's inbox, as in the suite above: the gate must not leak into it either.
    process.env.CEZ_TODOS_FILE = inheritedTodos;
    delete process.env.CEZ_FOLLOWUPS;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.ai/cezar', 'config.json'),
      JSON.stringify({ systemPrompt: CONFIG_PROMPT }),
      'utf8',
    );
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    // Cap 1 (workspace-level since step 2.5) serializes the suite's runs.
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }),
    });
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const workflow: WorkflowDef = {
    name: 'gate-probe',
    description: 'one step, no skill',
    source: 'built-in',
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  async function runToEnd(input: { task: string; generateFollowups?: boolean }): Promise<string> {
    writeFileSync(argsFile, '', 'utf8');
    const record = manager.startRun(workflow, input);
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
    return record.id;
  }

  const capturedSystemPrompt = (index = 0): string => {
    const lines = readFileSync(argsFile, 'utf8').trim().split('\n');
    const argv = JSON.parse(lines[index] as string) as string[];
    return argv[argv.indexOf('--append-system-prompt') + 1] as string;
  };

  it('without CEZ_FOLLOWUPS the agent is never told about the inbox', async () => {
    const todosFile = join(repoRoot, '.ai/cezar/todos.json');
    rmSync(todosFile, { force: true });
    rmSync(inheritedTodos, { force: true });

    const id = await runToEnd({ task: 'do the thing mock:done' });

    expect(capturedSystemPrompt()).toBe(composeSystemPrompt(CONFIG_PROMPT, HANDOFF_ONLY_INSTRUCTIONS));
    expect(capturedSystemPrompt()).not.toContain('CEZ_TODOS_FILE');
    expect(existsSync(todosFile)).toBe(false);
    // …and nothing leaked into the parent cezar's inbox either.
    expect(existsSync(inheritedTodos)).toBe(false);
    // The record agrees, so a later continuation reads the same answer.
    expect(store.getRun(id)?.generateFollowups).toBe(false);
  }, 30_000);

  it('keeps the per-task handoff journal — #471 turns off the inbox, not the notes', async () => {
    const id = await runToEnd({ task: 'do the thing mock:done' });
    expect(capturedSystemPrompt()).toContain('CEZ_HANDOFF_FILE');
    expect(capturedSystemPrompt()).toContain('CEZ:DONE');
    // The still-working marker rides in the same handoff contract (#490).
    expect(capturedSystemPrompt()).toContain('CEZ:MONITORING');
    // The task-reference markers too (spec 2026-07-18-task-ref-markers).
    expect(capturedSystemPrompt()).toContain('CEZ:PR=<number>');
    expect(capturedSystemPrompt()).toContain('CEZ:ISSUE=<number>');
    expect(capturedSystemPrompt()).toContain('CEZ:TITLE=');
    expect(readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.handoff.md`), 'utf8')).toContain(
      'mock: implemented the change',
    );
  }, 30_000);

  it('a client asking for follow-ups cannot override the gate', async () => {
    const todosFile = join(repoRoot, '.ai/cezar/todos.json');
    rmSync(todosFile, { force: true });
    const id = await runToEnd({ task: 'do the thing mock:done', generateFollowups: true });
    expect(capturedSystemPrompt()).not.toContain('CEZ_TODOS_FILE');
    expect(existsSync(todosFile)).toBe(false);
    expect(store.getRun(id)?.generateFollowups).toBe(false);
  }, 30_000);

  it('turning the flag on restores the inbox for a new run', async () => {
    const todosFile = join(repoRoot, '.ai/cezar/todos.json');
    rmSync(todosFile, { force: true });
    process.env.CEZ_FOLLOWUPS = '1';
    try {
      await runToEnd({ task: 'do the thing with follow-ups mock:done' });
      expect(capturedSystemPrompt()).toContain('CEZ_TODOS_FILE');
      expect(existsSync(todosFile)).toBe(true);
    } finally {
      delete process.env.CEZ_FOLLOWUPS;
    }
  }, 30_000);
});
