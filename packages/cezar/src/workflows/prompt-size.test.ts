/**
 * Prompt-size guard (#1225): prints per-turn prompt sizes for every measured backend and fails
 * when a component or a per-turn total grows past its committed ceiling.
 *
 * Offline: every backend is a bundled mock (`CEZ_DRY_RUN=1` for claude/cursor/pi; the codex and
 * opencode fixture mocks are selected explicitly because dry run does not reach them). Each mock
 * records what it actually received (`CEZ_MOCK_ARGS_FILE` argv, `CEZ_MOCK_STDIN_FILE` inbound
 * text), so the numbers are what cezar delivered, not a reimplementation of the composition.
 *
 * Units: JavaScript `string.length` characters of prompt text only — no protocol JSON, flags or
 * on-disk content the model reads. Tokens are an ESTIMATE (characters / 4); this test does not
 * answer what a provider bills or caches.
 *
 * WHEN THIS FAILS because you changed the prompt on purpose: review EVERY affected ceiling, not
 * just the one that tripped. Bump only the limits the approved new payload crosses, and LOWER
 * limits that text moving elsewhere or shrinking made obsolete. A change that shifts bytes between
 * components (system diet #1186, skills by path #1185) can pass every component ceiling and still
 * fail a total, or the reverse — the total is the one the model actually reads.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';
import { planChain } from '../planner.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { AUTONOMOUS_NUDGE, RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import {
  SELECTED_SKILL,
  formatTable,
  readJsonLines,
  skillBody,
  writeSyntheticSkills,
  type TurnSize,
} from './prompt-size.testkit.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Backends measured here. Every other RUNNER_IDS entry must be named in UNMEASURED, a recorded decision. */
const MEASURED = ['claude', 'codex', 'opencode', 'cursor', 'pi'] as const satisfies readonly RunnerId[];
/** No capturable offline mock yet: add capture hooks and move the id into MEASURED to cover it. */
const UNMEASURED = ['junie', 'copilot', 'omp', 'antigravity', 'gemini', 'kimi'] as const satisfies readonly RunnerId[];

const FIXTURES = new URL('../core/__fixtures__/', import.meta.url);
const CODEX_MOCK = fileURLToPath(new URL('codex/mock-codex-app-server.mjs', FIXTURES));
const OPENCODE_MOCK = fileURLToPath(new URL('opencode/mock-opencode-serve.mjs', FIXTURES));

const TASK = 'Fix the synthetic login redirect bug and add a regression test.';
const CONTINUE_TEXT = 'Please also update the changelog entry.';

/** Committed ceilings, characters. Set a little above the measured value; see the header. */
const CEILINGS = {
  /** Composed system prompt of any turn that carries one. */
  system: 13_500,
  /** The selected skill body inside it. */
  skill: 1_100,
  /** User text of a turn. */
  user: 260,
  /** Everything delivered for a turn. */
  total: 13_600,
  /** The planner call (system + user), catalog of 36 synthetic skills. */
  planner: 6_500,
};

interface Captured {
  argv: string[][];
  inbound: string[];
}

describe('prompt size per backend turn (#1225)', () => {
  let repoRoot: string;
  let captureDir: string;
  let store: RunStore;
  let manager: RunManager;
  const saved: Record<string, string | undefined> = {};
  const rows: TurnSize[] = [];
  const planner: Record<string, number> = {};
  let sequence = 0;

  const ENV_KEYS = [
    'CEZ_DRY_RUN', 'CEZ_CODEX_BIN', 'CEZ_OPENCODE_BIN', 'CEZ_CLAUDE_BIN', 'CEZ_CURSOR_BIN', 'CEZ_PI_BIN',
    'CEZ_MOCK_ARGS_FILE', 'CEZ_MOCK_STDIN_FILE', 'CEZ_FOLLOWUPS', 'CEZ_AUTONAME', 'CEZ_DISPATCH',
    'CEZ_AUTOMATIONS', 'CEZ_API_URL', 'CEZ_TODOS_FILE',
  ];

  beforeAll(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    for (const key of ['CEZ_CLAUDE_BIN', 'CEZ_CURSOR_BIN', 'CEZ_PI_BIN', 'CEZ_API_URL', 'CEZ_AUTOMATIONS', 'CEZ_TODOS_FILE', 'CEZ_AUTONAME']) {
      delete process.env[key];
    }
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_CODEX_BIN = CODEX_MOCK;
    process.env.CEZ_OPENCODE_BIN = OPENCODE_MOCK;
    process.env.CEZ_DISPATCH = '0';
    process.env.CEZ_FOLLOWUPS = '1'; // the handoff and todos contracts ride the prompt
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-promptsize-'));
    captureDir = join(repoRoot, '.captures');
    mkdirSync(captureDir, { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    writeFileSync(join(repoRoot, '.gitignore'), '.captures/\n');
    writeSyntheticSkills(repoRoot);
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }) });
  });

  afterAll(() => {
    manager.dispose();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.info(`\nPrompt sizes (characters; ~tokens = characters/4, an estimate)\n${formatTable(rows)}\n` +
      [...MEASURED].map((b) => `planner ${b}: ${planner[b] ?? 'unsupported offline'}${planner[b] ? ' chars' : ''}`).join('\n'));
  });

  /** Point the mocks at fresh capture files and return a reader. */
  function capture(): () => Captured {
    const id = ++sequence;
    const args = join(captureDir, `args-${id}.ndjson`);
    const stdin = join(captureDir, `stdin-${id}.ndjson`);
    process.env.CEZ_MOCK_ARGS_FILE = args;
    process.env.CEZ_MOCK_STDIN_FILE = stdin;
    return () => ({
      argv: readJsonLines<string[]>(args),
      inbound: readJsonLines<{ userText: string }>(stdin).map((m) => m.userText),
    });
  }

  const until = async (pred: () => boolean, ms = 20_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const systemFromArgv = (argv: string[]): string => argv[argv.indexOf('--append-system-prompt') + 1] ?? '';

  /** Split a delivered text into system and user parts around the known user text. */
  function splitDelivered(delivered: string, user: string): { system: number; user: number } {
    const at = delivered.lastIndexOf(user);
    return at < 0 ? { system: 0, user: delivered.length } : { system: at, user: user.length };
  }

  const row = (backend: string, turn: string, system: number, user: number, skill = 0): TurnSize => ({
    backend, turn, system, skill, user, total: system + user,
  });

  for (const backend of MEASURED) {
    it(`${backend}: opening turn, live message, Continue and planner stay under their ceilings`, async () => {
      const read = capture();
      const workflow: WorkflowDef = {
        name: 'prompt-size',
        source: 'built-in',
        steps: [{ id: 'work', name: SELECTED_SKILL, skill: SELECTED_SKILL, runner: backend, prompt: '{{task}}' }],
      };
      const record = manager.startRun(workflow, { task: TASK, runner: backend });
      await until(() => store.getRun(record.id)?.status === 'waiting');

      // Opening turn.
      const opening = read();
      const skill = skillBody(7).length;
      const turn: TurnSize[] = [];
      if (backend === 'claude' || backend === 'pi') {
        const system = systemFromArgv(opening.argv[0] ?? []).length;
        turn.push(row(backend, 'opening', system, (opening.inbound[0] ?? '').length, skill));
      } else if (backend === 'cursor') {
        const prompt = (opening.argv[0] ?? []).at(-1) ?? '';
        const parts = splitDelivered(prompt, TASK);
        turn.push(row(backend, 'opening', parts.system, parts.user, skill));
      } else {
        const parts = splitDelivered(opening.inbound[0] ?? '', TASK);
        turn.push(row(backend, 'opening', parts.system, parts.user, skill));
      }

      // Autonomous nudge as a live message into the open session.
      const before = read();
      const delivered = manager.sendMessage(record.id, [{ type: 'text', text: AUTONOMOUS_NUDGE }]);
      if (backend === 'cursor') {
        // Cursor sends the prompt as argv per fresh session: a live message is not a supported path.
        turn.push({ ...row(backend, 'nudge', 0, 0), note: 'unsupported' });
      } else {
        expect(delivered).toBe(true);
        await until(() => read().inbound.length > before.inbound.length);
        const text = read().inbound.at(-1) ?? '';
        turn.push(row(backend, 'nudge', 0, text.length));
      }

      // Continue: the session is closed, then reopened as a new one.
      await until(() => store.getRun(record.id)?.status === 'waiting');
      manager.finish(record.id);
      await until(() => ['done', 'review'].includes(store.getRun(record.id)?.status ?? ''));
      const beforeContinue = read();
      expect(manager.continueRun(record.id, { text: CONTINUE_TEXT }).ok).toBe(true);
      await until(() => {
        const now = read();
        return now.inbound.length > beforeContinue.inbound.length || now.argv.length > beforeContinue.argv.length;
      });
      const after = read();
      if (backend === 'claude' || backend === 'pi') {
        const argv = after.argv.at(-1) ?? [];
        turn.push(row(backend, 'continue', systemFromArgv(argv).length, (after.inbound.at(-1) ?? '').length));
      } else if (backend === 'cursor') {
        const parts = splitDelivered((after.argv.at(-1) ?? []).at(-1) ?? '', CONTINUE_TEXT);
        turn.push(row(backend, 'continue', parts.system, parts.user));
      } else {
        const parts = splitDelivered(after.inbound.at(-1) ?? '', CONTINUE_TEXT);
        turn.push(row(backend, 'continue', parts.system, parts.user));
      }
      manager.cancel(record.id);

      // Planner: the same synthetic catalog for every backend.
      const planRead = capture();
      writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ defaultRunner: backend }), 'utf8');
      await planChain(repoRoot, TASK);
      const plan = planRead();
      const planSystem = backend === 'claude' || backend === 'pi' ? systemFromArgv(plan.argv[0] ?? []).length : 0;
      // Identical retry inputs count once (planChain retries an unparseable mock answer).
      const planUser =
        backend === 'cursor' ? ((plan.argv[0] ?? []).at(-1) ?? '').length : (plan.inbound[0] ?? '').length;
      const planned = planSystem + planUser;
      if (backend === 'codex') {
        // Codex plans through restricted isolated startup, which needs a real app-server: the fixture
        // mock never sees the prompt, so planChain degrades. Recorded as unsupported, not skipped.
        expect(planned).toBe(0);
      } else {
        planner[backend] = planned;
      }

      rows.push(...turn);
      for (const t of turn) {
        if (t.note) continue;
        const where = `${t.backend} ${t.turn}`;
        expect(t.system, `${where} system`).toBeLessThan(CEILINGS.system);
        expect(t.user, `${where} user`).toBeLessThan(CEILINGS.user);
        expect(t.total, `${where} total`).toBeLessThan(CEILINGS.total);
        if (t.skill > 0) expect(t.skill, `${where} skill`).toBeLessThan(CEILINGS.skill);
      }
      if (backend !== 'codex') {
        expect(planner[backend] ?? 0, `${backend} planner`).toBeGreaterThan(0);
        expect(planner[backend] ?? 0, `${backend} planner`).toBeLessThan(CEILINGS.planner);
      }
    }, 90_000);
  }

  it('names every RUNNER_IDS entry as measured or deliberately unmeasured, so a new runner cannot escape', () => {
    expect([...MEASURED, ...UNMEASURED].sort()).toEqual([...RUNNER_IDS].sort());
  });
});
