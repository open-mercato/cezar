import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { isSignalTerminationExit, prependSystemPrompt } from './agent-runner.ts';
import {
  buildClaudeArgs,
  CLAUDE_COCKPIT_PERMISSION_GUIDANCE,
  CLAUDE_HEADLESS_GUIDANCE,
  claudePromptMode,
  ClaudeCliRunner,
  appendClaudeSystemPrompt,
  shouldSpoolSystemPrompt,
  writeClaudeSystemPromptFile,
  claudeExitMessage,
  claudeMcpServers,
  writeClaudeSettingsFile,
  EOF_KILL_GRACE_MS,
  EOF_TERM_GRACE_MS,
  KILL_GRACE_MS,
} from './claude-cli-runner.ts';
import { recordOwnSignal, resetOwnSignalsForTests } from './process-signals.ts';
import { ClaudeSessionCost, resetClaudeSessionCosts } from './claude-session-cost.ts';
import type { UiEvent } from './ui-events.ts';
import { CLAUDE_PERMISSION_ASK_PREFIX } from './claude-permission-prompt.ts';
import { connectorCallFence, connectorCallPrompt } from '../managers/connectors.ts';

/** Only the escalation tests below swap the child out; every other test in this
 *  file keeps spawning its real stub binary through the untouched `spawn`. */
const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

/**
 * The per-backend system-prompt delivery mechanism (spec §protocol v2
 * mapping table): claude gets `--append-system-prompt`, codex/opencode get
 * the prompt prepended to the opening user message (`prependSystemPrompt`,
 * shared by both runners).
 */
describe('buildClaudeArgs systemPrompt', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('emits --append-system-prompt with the exact text', () => {
    const args = buildClaudeArgs({ ...spec, systemPrompt: 'Extra rules.\n\n---\n\nContract.' });
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(appendClaudeSystemPrompt('Extra rules.\n\n---\n\nContract.'));
  });

  it('always appends Claude-local headless denial guidance', () => {
    const args = buildClaudeArgs(spec);
    const idx = args.indexOf('--append-system-prompt');
    expect(args[idx + 1]).toBe(CLAUDE_HEADLESS_GUIDANCE);
  });

  it('preserves caller instructions before the backend guidance', () => {
    expect(appendClaudeSystemPrompt('Caller rules.')).toBe(
      `Caller rules.\n\n---\n\n${CLAUDE_HEADLESS_GUIDANCE}`,
    );
  });

  it('uses the same guidance for a resumed call without changing resume args', () => {
    const initial = buildClaudeArgs({ ...spec, sessionId: 'session-1' });
    const resumed = buildClaudeArgs({ ...spec, sessionId: 'session-1', resume: true });
    expect(initial[initial.indexOf('--append-system-prompt') + 1]).toBe(CLAUDE_HEADLESS_GUIDANCE);
    expect(resumed[resumed.indexOf('--append-system-prompt') + 1]).toBe(CLAUDE_HEADLESS_GUIDANCE);
    expect(initial).toContain('--session-id');
    expect(resumed).toContain('--resume');
  });
});

describe('buildClaudeArgs enforceReadOnly', () => {
  const spec = { userPrompt: 'look', cwd: '/tmp', allowedTools: ['Read', 'Grep', 'Glob'] };

  it('denies the write tools, so settings allow rules cannot grant them back', () => {
    const args = buildClaudeArgs({ ...spec, enforceReadOnly: true });
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash,Edit,Write,MultiEdit,NotebookEdit');
  });

  it('denies nothing on an ordinary run', () => {
    expect(buildClaudeArgs(spec)).not.toContain('--disallowedTools');
  });
});

describe('buildClaudeArgs noMcpServers', () => {
  const spec = { userPrompt: 'look', cwd: '/tmp', allowedTools: ['Read'] };
  const server = { name: 'docs', command: 'docs-mcp', args: [], env: {} } as never;

  it('loads no MCP server, a private one included', () => {
    const args = buildClaudeArgs({ ...spec, noMcpServers: true, mcpServers: [server] }, {}, '/tmp/mcp.json');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--mcp-config');
  });

  it('keeps the configured servers on an ordinary run', () => {
    expect(buildClaudeArgs(spec)).not.toContain('--strict-mcp-config');
  });

  it('also switches claude.ai connectors off in the child, and only then', async () => {
    const bin = fileURLToPath(new URL('./__fixtures__/claude/stub-reports-mcp-switches.mjs', import.meta.url));
    const run = (noMcpServers: boolean) => new ClaudeCliRunner({ bin, timeoutMs: 0 })
      .run({ ...spec, cwd: process.cwd(), env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'kept' }, ...(noMcpServers ? { noMcpServers } : {}) });
    expect((await run(true)).text).toBe('claudeai=false strict=true');
    expect((await run(false)).text).toBe('claudeai=kept strict=false');
  });
});

describe('buildClaudeArgs bashHookCommand', () => {
  const spec = { userPrompt: 'look', cwd: '/tmp', allowedTools: ['Read', 'Bash'], bashAllowlist: ['gh pr view'] };

  it('installs it as a Bash PreToolUse hook beside the prefix rules', () => {
    const args = buildClaudeArgs({ ...spec, bashHookCommand: "'/usr/bin/node' '/x/hook.js'" });
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Bash(gh pr view:*)');
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: "'/usr/bin/node' '/x/hook.js'" }] }] },
    });
  });

  it('adds no settings without a hook, or when Bash is not allowed at all', () => {
    expect(buildClaudeArgs(spec)).not.toContain('--settings');
    expect(buildClaudeArgs({ ...spec, allowedTools: ['Read'], bashHookCommand: 'x' })).not.toContain('--settings');
  });

  // The Seatbelt sandbox denies the loopback connect, so `cez-manager` failed with `fetch failed`.
  it('excludes sandboxExcludedCommands from the sandbox in the same settings as the hook', () => {
    const args = buildClaudeArgs({ ...spec, bashHookCommand: 'h', sandboxExcludedCommands: ['cez-manager *'] });
    expect(args.filter((arg) => arg === '--settings')).toHaveLength(1);
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'h' }] }] },
      sandbox: { excludedCommands: ['cez-manager *'] },
    });
    const alone = buildClaudeArgs({ ...spec, sandboxExcludedCommands: ['cez-manager *'] });
    expect(JSON.parse(alone[alone.indexOf('--settings') + 1]!)).toEqual({ sandbox: { excludedCommands: ['cez-manager *'] } });
    expect(buildClaudeArgs({ ...spec, allowedTools: ['Read'], sandboxExcludedCommands: ['cez-manager *'] })).not.toContain('--settings');
  });
});

describe('buildClaudeArgs bypassPermissions', () => {
  const spec = { userPrompt: 'go', cwd: '/tmp' };
  const mode = (args: string[]) => args[args.indexOf('--permission-mode') + 1];

  it('skips every prompt only when the project opted in, and never for a read-only run', () => {
    expect(mode(buildClaudeArgs(spec))).toBe('dontAsk');
    expect(mode(buildClaudeArgs({ ...spec, bypassPermissions: true }))).toBe('bypassPermissions');
    expect(mode(buildClaudeArgs({ ...spec, bypassPermissions: true }, { CEZ_APPROVAL_GATE: '1' }))).toBe('bypassPermissions');
    expect(mode(buildClaudeArgs({ ...spec, bypassPermissions: true, enforceReadOnly: true }))).toBe('dontAsk');
  });
});

describe('buildClaudeArgs output mode', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('runs in print mode, which both stream-json formats require', () => {
    expect(buildClaudeArgs(spec)).toContain('--print');
  });

  it('asks for partial messages so text streams as deltas', () => {
    expect(buildClaudeArgs(spec)).toContain('--include-partial-messages');
  });

  it('passes a reasoning effort as --effort (#808)', () => {
    const args = buildClaudeArgs({ ...spec, reasoningEffort: 'xhigh' });
    expect(args[args.indexOf('--effort') + 1]).toBe('xhigh');
  });

  it('re-sends the effort on a resumed session, since --effort is session-scoped', () => {
    const args = buildClaudeArgs({ ...spec, sessionId: 's1', resume: true, reasoningEffort: 'low' });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
  });

  it('leaves the native effort untouched when none is chosen', () => {
    expect(buildClaudeArgs(spec)).not.toContain('--effort');
  });
});

describe('buildClaudeArgs approval gate', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('denies unapproved tools without prompting by default', () => {
    const args = buildClaudeArgs(spec, {});
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('dontAsk');
  });

  it('enables Claude approval prompts only when explicitly requested', () => {
    const args = buildClaudeArgs(spec, { CEZ_APPROVAL_GATE: '1' });
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('acceptEdits');
  });
});

describe('buildClaudeArgs claudePermissionMode (spec 2026-07-17-permission-modes, Claude phase)', () => {
  const spec = { userPrompt: 'go', cwd: '/tmp' };
  const mode = (args: string[]) => args[args.indexOf('--permission-mode') + 1];
  const promptTool = (args: string[]) => {
    const at = args.indexOf('--permission-prompt-tool');
    return at < 0 ? undefined : args[at + 1];
  };
  const wide = ['Read', 'Edit', 'Write', 'Bash'];

  it('leaves the default argv byte-identical: dontAsk and no prompt tool', () => {
    const args = buildClaudeArgs(spec, {});
    expect(mode(args)).toBe('dontAsk');
    expect(args).not.toContain('--permission-prompt-tool');
    expect(claudePromptMode(spec, {})).toEqual({ permissionMode: 'dontAsk', promptTool: false });
  });

  it('keeps CEZ_APPROVAL_GATE as acceptEdits without a prompt channel', () => {
    const args = buildClaudeArgs(spec, { CEZ_APPROVAL_GATE: '1' });
    expect(mode(args)).toBe('acceptEdits');
    expect(args).not.toContain('--permission-prompt-tool');
  });

  it('manual asks on the stdio channel', () => {
    const args = buildClaudeArgs({ ...spec, claudePermissionMode: 'manual' }, {});
    expect(mode(args)).toBe('manual');
    expect(promptTool(args)).toBe('stdio');
  });

  it('beats the approval gate, which has no prompt tool', () => {
    const args = buildClaudeArgs({ ...spec, claudePermissionMode: 'manual' }, { CEZ_APPROVAL_GATE: '1' });
    expect(mode(args)).toBe('manual');
    expect(promptTool(args)).toBe('stdio');
  });

  it('is beaten by read-only, strict and bypassPermissions, and adds no prompt tool then', () => {
    for (const [extra, expected] of [
      [{ enforceReadOnly: true }, 'dontAsk'],
      [{ strictPermissions: true }, 'dontAsk'],
      [{ bypassPermissions: true }, 'bypassPermissions'],
      [{ bypassPermissions: true, enforceReadOnly: true }, 'dontAsk'],
    ] as const) {
      const args = buildClaudeArgs({ ...spec, claudePermissionMode: 'manual', ...extra }, {});
      expect(mode(args)).toBe(expected);
      expect(args).not.toContain('--permission-prompt-tool');
    }
  });

  it('acceptEdits holds only when the step already allows Edit, Write and unrestricted Bash', () => {
    const accept = { ...spec, claudePermissionMode: 'acceptEdits' as const };
    const args = buildClaudeArgs({ ...accept, allowedTools: wide }, {});
    expect(mode(args)).toBe('acceptEdits');
    expect(promptTool(args)).toBe('stdio');
    // A repo-tracked config must never widen a step's tool fence: anything less falls back to manual.
    for (const narrower of [
      { allowedTools: ['Read', 'Edit', 'Bash'] },
      { allowedTools: ['Read', 'Write', 'Bash'] },
      { allowedTools: ['Read', 'Edit', 'Write'] },
      { allowedTools: wide, bashAllowlist: ['git status'] },
      {},
    ]) {
      const fallback = buildClaudeArgs({ ...accept, ...narrower }, {});
      expect(mode(fallback)).toBe('manual');
      expect(promptTool(fallback)).toBe('stdio');
    }
  });

  it('carries the prompt tool on a resumed spawn, since flags come from the spec every time', () => {
    const args = buildClaudeArgs({ ...spec, sessionId: 's1', resume: true, claudePermissionMode: 'manual' }, {});
    expect(args).toContain('--resume');
    expect(mode(args)).toBe('manual');
    expect(promptTool(args)).toBe('stdio');
  });

  it('agrees with claudePromptMode', () => {
    expect(claudePromptMode({ ...spec, claudePermissionMode: 'manual' }, {})).toEqual({ permissionMode: 'manual', promptTool: true });
    expect(claudePromptMode({ ...spec, claudePermissionMode: 'acceptEdits', allowedTools: wide }, {})).toEqual({ permissionMode: 'acceptEdits', promptTool: true });
    expect(claudePromptMode({ ...spec, claudePermissionMode: 'acceptEdits' }, {})).toEqual({ permissionMode: 'manual', promptTool: true });
    expect(claudePromptMode({ ...spec, claudePermissionMode: 'manual', enforceReadOnly: true }, {})).toEqual({ permissionMode: 'dontAsk', promptTool: false });
    expect(claudePromptMode(spec, { CEZ_APPROVAL_GATE: '1' })).toEqual({ permissionMode: 'acceptEdits', promptTool: false });
  });
});

describe('Claude system prompt guidance for permission prompts', () => {
  const spec = { userPrompt: 'go', cwd: '/tmp' };
  const prompt = (args: string[]) => args[args.indexOf('--append-system-prompt') + 1];

  it('keeps the headless guidance verbatim whenever a prompt cannot be answered', () => {
    expect(appendClaudeSystemPrompt(undefined)).toBe(CLAUDE_HEADLESS_GUIDANCE);
    expect(appendClaudeSystemPrompt('Rules.', false)).toBe(`Rules.\n\n---\n\n${CLAUDE_HEADLESS_GUIDANCE}`);
    expect(prompt(buildClaudeArgs({ ...spec, claudePermissionMode: 'manual' }, {}))).toBe(CLAUDE_HEADLESS_GUIDANCE);
  });

  it('swaps in the cockpit guidance when the user can answer', () => {
    expect(appendClaudeSystemPrompt('Rules.', true)).toBe(`Rules.\n\n---\n\n${CLAUDE_COCKPIT_PERMISSION_GUIDANCE}`);
    expect(CLAUDE_COCKPIT_PERMISSION_GUIDANCE).not.toBe(CLAUDE_HEADLESS_GUIDANCE);
    expect(CLAUDE_COCKPIT_PERMISSION_GUIDANCE).toMatch(/cezar cockpit/);
    expect(CLAUDE_COCKPIT_PERMISSION_GUIDANCE).toMatch(/Shift\+Tab/);
    const args = buildClaudeArgs({ ...spec, claudePermissionMode: 'manual' }, {}, undefined, undefined, undefined, true);
    expect(prompt(args)).toBe(CLAUDE_COCKPIT_PERMISSION_GUIDANCE);
  });

  it('never swaps it in without the prompt tool', () => {
    expect(prompt(buildClaudeArgs(spec, {}, undefined, undefined, undefined, true))).toBe(CLAUDE_HEADLESS_GUIDANCE);
    expect(prompt(buildClaudeArgs({ ...spec, enforceReadOnly: true, claudePermissionMode: 'manual' }, {}, undefined, undefined, undefined, true)))
      .toBe(CLAUDE_HEADLESS_GUIDANCE);
  });
});

/**
 * Permission prompts (`control_request` / `can_use_tool`) answered from the cockpit. The runner is
 * driven by a tiny fake CLI that emits scripted frames after the first user message and logs every
 * stdin line, so the exact `control_response` the CLI would receive is asserted.
 */
describe('ClaudeCliRunner permission prompts', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-claude-permission-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const request = (id: string, extra: Record<string, unknown> = {}) => ({
    type: 'control_request',
    request_id: id,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: `touch ${id}` },
      tool_use_id: `toolu_${id}`,
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: `touch ${id}:*` }], behavior: 'allow', destination: 'localSettings' }],
      ...extra,
    },
  });

  /** A CLI that emits `first` after its first user line, optionally `exitAfterMs` later, and logs stdin. */
  function fakeClaude(first: unknown[], opts: { exitAfterMs?: number } = {}): { bin: string; log: () => Array<Record<string, any>> } {
    const bin = join(dir, 'claude-fake.mjs');
    const logFile = join(dir, 'stdin.log');
    writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const first = ${JSON.stringify(first)};
let started = false;
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-opus-5-5' }));
createInterface({ input: process.stdin }).on('line', (line) => {
  appendFileSync(${JSON.stringify(logFile)}, line + '\\n');
  if (started || JSON.parse(line).type !== 'user') return;
  started = true;
  for (const frame of first) console.log(JSON.stringify(frame));
  ${opts.exitAfterMs !== undefined ? `setTimeout(() => process.exit(0), ${opts.exitAfterMs});` : ''}
}).on('close', () => process.exit(0));
`, { mode: 0o700 });
    return {
      bin,
      log: () => {
        try {
          return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        } catch {
          return [];
        }
      },
    };
  }

  const responses = (log: Array<Record<string, any>>) => log.filter((l) => l.type === 'control_response');
  const until = async (cond: () => boolean, ms = 4_000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const cards = (ui: UiEvent[]) => ui.flatMap((e) => (e.type === 'ask.requested' ? [e.requestId] : []));
  const start = (bin: string, opts: { canAsk?: boolean; ui?: UiEvent[]; events?: AgentEvent[] } = {}) => {
    const ui = opts.ui ?? [];
    const session = new ClaudeCliRunner({ bin, timeoutMs: 0 }).startSession(
      { userPrompt: 'go', cwd: dir, claudePermissionMode: 'manual' },
      (event) => opts.events?.push(event),
      { onUiEvent: (e) => ui.push(e), canAskPermission: () => opts.canAsk ?? true },
    );
    return { session, ui };
  };
  const id = (raw: string) => `${CLAUDE_PERMISSION_ASK_PREFIX}${raw}`;

  it('raises a card and writes nothing until the user answers', async () => {
    const fake = fakeClaude([request('r1')]);
    const { session, ui } = start(fake.bin);
    try {
      await until(() => cards(ui).length === 1);
      expect(cards(ui)).toEqual([id('r1')]);
      expect(session.hasPendingPermission?.()).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(responses(fake.log())).toEqual([]);
    } finally {
      session.interrupt();
      await session.result;
    }
  }, 15_000);

  it('writes the allow response out of band, without starting a turn', async () => {
    const fake = fakeClaude([request('r1')]);
    const { session, ui } = start(fake.bin);
    try {
      await until(() => cards(ui).length === 1);
      const turnsBefore = ui.filter((e) => e.type === 'turn.started').length;
      expect(session.respondPermission?.(id('r1'), 'Permission: Always allow')).toBe(true);
      await until(() => responses(fake.log()).length === 1);
      expect(responses(fake.log())[0]).toEqual({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'r1',
          response: {
            behavior: 'allow',
            updatedInput: { command: 'touch r1' },
            toolUseID: 'toolu_r1',
            updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch r1:*' }], behavior: 'allow', destination: 'session' }],
          },
        },
      });
      // Never a user turn: the only `user` line on stdin is the seed prompt.
      expect(fake.log().filter((l) => l.type === 'user')).toHaveLength(1);
      expect(ui.filter((e) => e.type === 'turn.started')).toHaveLength(turnsBefore);
      expect(session.hasPendingPermission?.()).toBe(false);
      expect(session.respondPermission?.(id('r1'), 'Allow once')).toBe(false);
    } finally {
      session.interrupt();
      await session.result;
    }
  }, 15_000);

  it('writes a deny with the user\'s words for free text', async () => {
    const fake = fakeClaude([request('r1')]);
    const { session, ui } = start(fake.bin);
    try {
      await until(() => cards(ui).length === 1);
      expect(session.respondPermission?.(id('r1'), 'Need more info')).toBe(true);
      await until(() => responses(fake.log()).length === 1);
      const body = responses(fake.log())[0]!.response.response;
      expect(body).toMatchObject({ behavior: 'deny', toolUseID: 'toolu_r1' });
      expect(body.message).toContain('Need more info');
    } finally {
      session.interrupt();
      await session.result;
    }
  }, 15_000);

  it('shows one card at a time, the next after the head is answered', async () => {
    const fake = fakeClaude([request('r1'), request('r2')]);
    const { session, ui } = start(fake.bin);
    try {
      await until(() => cards(ui).length === 1);
      await new Promise((r) => setTimeout(r, 50));
      expect(cards(ui)).toEqual([id('r1')]);
      // Only the head can be answered; the other is still queued.
      expect(session.respondPermission?.(id('zzz'), 'Reject')).toBe(false);
      expect(session.respondPermission?.(id('r1'), 'Reject')).toBe(true);
      await until(() => cards(ui).length === 2);
      expect(cards(ui)).toEqual([id('r1'), id('r2')]);
      expect(session.hasPendingPermission?.()).toBe(true);
      expect(session.respondPermission?.(id('r2'), 'Allow once')).toBe(true);
      await until(() => responses(fake.log()).length === 2);
      expect(responses(fake.log()).map((l) => l.response.request_id)).toEqual(['r1', 'r2']);
      expect(session.hasPendingPermission?.()).toBe(false);
    } finally {
      session.interrupt();
      await session.result;
    }
  }, 15_000);

  it('answers hasPendingPermission per card id when two prompts are queued', async () => {
    const fake = fakeClaude([request('r1'), request('r2'), request('r3'), { type: 'control_cancel_request', request_id: 'r3' }]);
    const { session, ui } = start(fake.bin);
    try {
      await until(() => cards(ui).length === 1 && ui.some((e) => e.type === 'ask.closed'));
      expect(session.hasPendingPermission?.()).toBe(true);
      expect(session.hasPendingPermission?.(id('r1'))).toBe(true);
      expect(session.hasPendingPermission?.(id('r2'))).toBe(true);
      // Withdrawn by Claude: no longer pending, though others are.
      expect(session.hasPendingPermission?.(id('r3'))).toBe(false);
      expect(session.hasPendingPermission?.(id('nope'))).toBe(false);
      expect(session.respondPermission?.(id('r1'), 'Allow once')).toBe(true);
      // Answered: gone; the other still waits, and the any-query stays true.
      expect(session.hasPendingPermission?.(id('r1'))).toBe(false);
      expect(session.hasPendingPermission?.(id('r2'))).toBe(true);
      expect(session.hasPendingPermission?.()).toBe(true);
    } finally {
      session.interrupt();
      await session.result;
    }
  }, 15_000);

  it('denies at once, with a note and no card, when nobody can answer', async () => {
    const fake = fakeClaude([request('r1')]);
    const events: AgentEvent[] = [];
    const { session, ui } = start(fake.bin, { canAsk: false, events });
    try {
      await until(() => responses(fake.log()).length === 1);
      expect(responses(fake.log())[0]!.response.response).toMatchObject({ behavior: 'deny', toolUseID: 'toolu_r1' });
      expect(responses(fake.log())[0]!.response.response.message).toContain('nobody can answer permission prompts in this run');
      expect(cards(ui)).toEqual([]);
      expect(events).toContainEqual({ type: 'note', message: 'claude: refused Bash (nobody can answer permission prompts in this run)' });
      expect(session.hasPendingPermission?.()).toBe(false);
    } finally {
      session.interrupt();
      await session.result;
    }
  }, 15_000);

  it('denies at once when there is no UI channel at all', async () => {
    const fake = fakeClaude([request('r1')]);
    const session = new ClaudeCliRunner({ bin: fake.bin, timeoutMs: 0 }).startSession(
      { userPrompt: 'go', cwd: dir, claudePermissionMode: 'manual' },
      undefined,
      { canAskPermission: () => true },
    );
    try {
      await until(() => responses(fake.log()).length === 1);
      expect(responses(fake.log())[0]!.response.response).toMatchObject({ behavior: 'deny' });
    } finally {
      session.interrupt();
      await session.result;
    }
  }, 15_000);

  it('denies AskUserQuestion and ExitPlanMode at once even when a user could answer', async () => {
    const fake = fakeClaude([request('r1', { tool_name: 'AskUserQuestion', input: { questions: [] } }), request('r2', { tool_name: 'ExitPlanMode', input: {} })]);
    const events: AgentEvent[] = [];
    const { session, ui } = start(fake.bin, { events });
    try {
      await until(() => responses(fake.log()).length === 2);
      const [ask, plan] = responses(fake.log()).map((l) => l.response.response);
      expect(ask).toMatchObject({ behavior: 'deny' });
      expect(ask.message).toMatch(/CEZ:ASK/);
      expect(plan).toMatchObject({ behavior: 'deny' });
      expect(cards(ui)).toEqual([]);
      expect(events.some((e) => e.type === 'note' && /AskUserQuestion/.test(e.message))).toBe(true);
    } finally {
      session.interrupt();
      await session.result;
    }
  }, 15_000);

  it('retracts a card when Claude withdraws the request, and raises the next one', async () => {
    const fake = fakeClaude([request('r1'), request('r2'), { type: 'control_cancel_request', request_id: 'r1' }]);
    const { session, ui } = start(fake.bin);
    try {
      await until(() => cards(ui).length === 2);
      expect(ui).toContainEqual({ type: 'ask.closed', requestId: id('r1'), reason: 'retracted', detail: 'Claude withdrew the permission prompt' });
      expect(cards(ui)).toEqual([id('r1'), id('r2')]);
      expect(session.respondPermission?.(id('r1'), 'Allow once')).toBe(false);
      expect(session.respondPermission?.(id('r2'), 'Allow once')).toBe(true);
    } finally {
      session.interrupt();
      await session.result;
    }
  }, 15_000);

  it('answers an unsupported control request with an error response', async () => {
    const fake = fakeClaude([{ type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback' } }]);
    const { session, ui } = start(fake.bin);
    try {
      await until(() => responses(fake.log()).length === 1);
      expect(responses(fake.log())[0]).toEqual({
        type: 'control_response',
        response: { subtype: 'error', request_id: 'h1', error: expect.stringContaining('hook_callback') },
      });
      expect(cards(ui)).toEqual([]);
    } finally {
      session.interrupt();
      await session.result;
    }
  }, 15_000);

  it('expires every pending card when the session ends, and refuses a late answer', async () => {
    const fake = fakeClaude([request('r1'), request('r2')], { exitAfterMs: 100 });
    const { session, ui } = start(fake.bin);
    await session.result;
    const detail = 'the Claude session ended before this permission prompt was answered';
    expect(ui).toContainEqual({ type: 'ask.closed', requestId: id('r1'), reason: 'expired', detail });
    expect(ui).toContainEqual({ type: 'ask.closed', requestId: id('r2'), reason: 'expired', detail });
    expect(session.hasPendingPermission?.()).toBe(false);
    expect(session.respondPermission?.(id('r1'), 'Allow once')).toBe(false);
  }, 15_000);

  it('keeps the prompt pending when stdin is already closed, and says it was not delivered', async () => {
    const fake = fakeClaude([request('r1')]);
    const { session, ui } = start(fake.bin);
    try {
      await until(() => cards(ui).length === 1);
      session.end();
      expect(session.respondPermission?.(id('r1'), 'Allow once')).toBe(false);
      expect(session.hasPendingPermission?.()).toBe(true);
    } finally {
      session.interrupt();
      await session.result;
    }
  }, 15_000);

  it('refuses a can_use_tool at once when the prompt tool is off, even if a user could answer', async () => {
    const fake = fakeClaude([request('r1')]);
    const ui: UiEvent[] = [];
    const session = new ClaudeCliRunner({ bin: fake.bin, timeoutMs: 0 }).startSession(
      { userPrompt: 'go', cwd: dir },
      undefined,
      { onUiEvent: (e) => ui.push(e), canAskPermission: () => true },
    );
    try {
      await until(() => responses(fake.log()).length === 1);
      expect(responses(fake.log())[0]!.response.response).toMatchObject({ behavior: 'deny' });
      expect(cards(ui)).toEqual([]);
      expect(session.hasPendingPermission?.()).toBe(false);
    } finally {
      session.interrupt();
      await session.result;
    }
  }, 15_000);

  it('still maps a non-control frame that carries a request_id (default mode)', async () => {
    const fake = fakeClaude([{ type: 'assistant', request_id: 'x1', message: { role: 'assistant', content: [{ type: 'text', text: 'hello there' }] } }]);
    const events: AgentEvent[] = [];
    const session = new ClaudeCliRunner({ bin: fake.bin, timeoutMs: 0 }).startSession({ userPrompt: 'go', cwd: dir }, (e) => events.push(e), {});
    try {
      await until(() => events.some((e) => e.type === 'text'));
      expect(events).toContainEqual({ type: 'text', text: 'hello there' });
      expect(responses(fake.log())).toEqual([]);
    } finally {
      session.interrupt();
      await session.result;
    }
  }, 15_000);

  it('keeps the prompt pending and answerable across a user message (verified against claude 2.1.332)', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    const session = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { userPrompt: 'permission-probe', cwd: dir, claudePermissionMode: 'manual', env: { CEZ_HANDOFF_FILE: '', CEZ_MOCK_ARGS_FILE: '', CEZ_TODOS_FILE: '' } },
      (event) => events.push(event),
      { onUiEvent: (e) => ui.push(e), canAskPermission: () => true },
    );
    try {
      await until(() => cards(ui).length === 1);
      expect(session.sendMessage([{ type: 'text', text: 'also mention the weather' }])).toBe(true);
      await new Promise((r) => setTimeout(r, 100));
      // The CLI holds the message; the prompt is neither cancelled nor answered by it.
      expect(session.hasPendingPermission?.()).toBe(true);
      expect(ui.some((e) => e.type === 'ask.closed')).toBe(false);
      expect(events.some((e) => e.type === 'tool-result')).toBe(false);
      expect(session.respondPermission?.(cards(ui)[0]!, 'Allow once')).toBe(true);
      await until(() => events.some((e) => e.type === 'tool-result'));
      expect(events.find((e) => e.type === 'tool-result')).toMatchObject({ isError: false });
      // The held message is then answered as its own turn.
      await until(() => events.some((e) => e.type === 'text' && e.text.includes('Follow-up')));
    } finally {
      session.interrupt();
      await session.result;
    }
  }, 20_000);

  it('drives the dry-run mock end to end: card, answer, tool result', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    const session = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      {
        userPrompt: 'permission-probe',
        cwd: dir,
        claudePermissionMode: 'manual',
        env: { CEZ_HANDOFF_FILE: '', CEZ_MOCK_ARGS_FILE: '', CEZ_TODOS_FILE: '' },
      },
      (event) => events.push(event),
      { onUiEvent: (e) => ui.push(e), canAskPermission: () => true, autoEndAfterFirstTurn: true },
    );
    await until(() => cards(ui).length === 1);
    expect(cards(ui)[0]).toMatch(new RegExp(`^${CLAUDE_PERMISSION_ASK_PREFIX}`));
    const card = ui.find((e) => e.type === 'ask.requested');
    expect(card?.type === 'ask.requested' && card.questions[0]!.question).toContain('touch cez-permission-probe.txt');
    expect(session.respondPermission?.(cards(ui)[0]!, 'Reject')).toBe(true);
    await session.result;
    const result = events.find((e) => e.type === 'tool-result');
    expect(result).toMatchObject({ isError: true });
    expect(result?.type === 'tool-result' && result.result).toContain('rejected');
  }, 20_000);

  it('the mock stays silent about permissions when started without the prompt tool', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const ui: UiEvent[] = [];
    const result = await new ClaudeCliRunner({ bin: mockBin, timeoutMs: 20_000 }).startSession(
      { userPrompt: 'permission-probe', cwd: dir, env: { CEZ_HANDOFF_FILE: '', CEZ_MOCK_ARGS_FILE: '', CEZ_TODOS_FILE: '' } },
      undefined,
      { onUiEvent: (e) => ui.push(e), canAskPermission: () => true, autoEndAfterFirstTurn: true },
    ).result;
    expect(cards(ui)).toEqual([]);
    expect(result.text).toContain('Done with the first pass');
  }, 25_000);
});

/**
 * #703 — a session cezar tore down itself must not settle as an agent
 * failure. Every agent CLI installs its own stop-signal handler and exits
 * `128 + signal`, so the runner sees a NON-ZERO code for a teardown it
 * asked for (goal achieved → `end()`, or a user cancel → `interrupt()`).
 */
describe('isSignalTerminationExit', () => {
  it('recognizes the 128+signal codes a signalled CLI reports', () => {
    expect(isSignalTerminationExit(130)).toBe(true); // SIGINT
    expect(isSignalTerminationExit(137)).toBe(true); // SIGKILL
    expect(isSignalTerminationExit(143)).toBe(true); // SIGTERM
  });

  it('leaves genuine failures and clean exits alone', () => {
    for (const code of [0, 1, 2, 127, null]) {
      expect(isSignalTerminationExit(code)).toBe(false);
    }
  });
});

describe('a teardown cezar initiated', () => {
  const stubBin = fileURLToPath(
    new URL('./__fixtures__/claude/stub-ignores-eof-exits-143.mjs', import.meta.url),
  );

  it('settles the session instead of failing it when the CLI exits 143', async () => {
    const runner = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const uiEvents: UiEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      { userPrompt: 'do it', cwd: process.cwd() },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
      { onUiEvent: (event) => uiEvents.push(event) },
    );
    await firstText;

    // The cancel path; the EOF watchdog reaches the same `signalChild`.
    session.interrupt();
    const result = await session.result;

    expect(result.text).toBe('work done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(
      uiEvents.some((event) => event.type === 'turn.completed' && event.stopReason === 'error'),
    ).toBe(false);
    expect(uiEvents).toContainEqual({
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
    });
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(
      events.some((e) => e.type === 'note' && e.message.includes('terminated by cezar (code 143)')),
    ).toBe(true);
  }, 15_000);
});

// Telemetry 3ac6bbe3: a SIGTERM that reached cezar too (a unit stop, a logout, the group's Ctrl-C)
// made claude exit 143 mid-shutdown, and the run was failed and reported as a crash.
describe('a 143 exit while cezar itself is being signalled', () => {
  const stubBin = fileURLToPath(new URL('./__fixtures__/claude/stub-exits-143-on-its-own.mjs', import.meta.url));
  afterEach(() => resetOwnSignalsForTests());

  it('stays unsettled through the shutdown, then settles as an interruption', async () => {
    resetOwnSignalsForTests(1_000);
    const events: AgentEvent[] = [];
    const session = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 })
      .startSession({ userPrompt: 'do it', cwd: process.cwd() }, (event) => events.push(event));
    recordOwnSignal('SIGTERM');
    let settled = false;
    const outcome = session.result.then(
      () => 'resolved',
      (err: Error) => err.message,
    ).finally(() => { settled = true; });

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(settled).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(false);

    expect(await outcome).toBe('interrupted — cezar received SIGTERM and the claude CLI stopped with it (code 143)');
  }, 15_000);

  it('still fails with the signal named when only the CLI was signalled', async () => {
    const session = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 })
      .startSession({ userPrompt: 'do it', cwd: process.cwd() }, () => {});
    await expect(session.result).rejects.toThrow('claude CLI exited with code 143 (SIGTERM: a signal cezar did not send)');
  }, 15_000);

  it('ignores a signal cezar received before the session started', async () => {
    recordOwnSignal('SIGTERM', Date.now() - 60_000);
    const session = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 })
      .startSession({ userPrompt: 'do it', cwd: process.cwd() }, () => {});
    await expect(session.result).rejects.toThrow('a signal cezar did not send');
  }, 15_000);
});

/**
 * #844 — the watchdogs used to ask `!child.killed` before escalating, but Node
 * sets `killed` the moment a signal is *delivered*. claude installs its own
 * SIGTERM handler, so the flag went true while the process ran on and the
 * SIGKILL that exists for exactly that case was never sent — one leaked CLI per
 * teardown. The escalation now follows real termination instead.
 */
describe('SIGTERM→SIGKILL escalation for a CLI that survives SIGTERM', () => {
  function signallableChild(): {
    child: ChildProcessWithoutNullStreams;
    signals: NodeJS.Signals[];
    exit: (code: number) => void;
  } {
    const signals: NodeJS.Signals[] = [];
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 4242,
      // Node's semantics: delivery flips `killed`; a CLI with its own handler
      // keeps running with `exitCode` still null.
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        Object.assign(child, { killed: true });
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    const exit = (code: number) => {
      Object.assign(child, { exitCode: code });
      emitter.emit('exit', code, null);
    };
    return { child, signals, exit };
  }

  function withFakeChild(run: (fake: ReturnType<typeof signallableChild>) => void): void {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      run(fake);
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  }

  it('escalates after end() even though Node already flagged the child as killed', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      session.end();

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
      // Delivered, not dead — the state that used to disable the escalation.
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      vi.advanceTimersByTime(EOF_KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('escalates on the wall-clock timeout path as well', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  // cf2191f1: a 30-minute WALL clock killed steps that were still streaming work.
  it('never kills a session that keeps streaming, only one that went silent for the whole window', async () => {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [];
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 1_000 }).startSession(
        { userPrompt: 'do it', cwd: process.cwd() },
        (event) => events.push(event),
      );
      void session.result.catch(() => undefined);
      const frame = `${JSON.stringify({ type: 'system', subtype: 'status' })}\n`;
      for (let i = 0; i < 5; i += 1) {
        (fake.child.stdout as PassThrough).write(frame);
        await vi.advanceTimersByTimeAsync(800);
      }
      // 4 s of wall clock against a 1 s limit: still alive, because it never went quiet.
      expect(fake.signals).toEqual([]);

      await vi.advanceTimersByTimeAsync(200);
      expect(fake.signals).toEqual(['SIGTERM']);
      fake.exit(143);
      await session.result;
      const error = events.find((e) => e.type === 'error');
      expect(error).toEqual({
        type: 'error',
        message: 'claude CLI timed out after 1s without any output and was killed — Continue picks the task up again',
      });
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  });

  it('stops escalating once the CLI really exits after SIGTERM', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      session.end();

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
      fake.exit(143);

      vi.advanceTimersByTime(EOF_KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
    });
  });

  it('stops accepting messages once the child has exited on its own', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      expect(session.open).toBe(true);
      fake.exit(1);

      expect(session.open).toBe(false);
      expect(session.sendMessage([{ type: 'text', text: 'are you there?' }])).toBe(false);
    });
  });
});

describe('claudeExitMessage', () => {
  it('names a hangup the CLI exited on, which cezar never sends (telemetry 046a0525)', () => {
    expect(claudeExitMessage(129, '')).toBe(
      'claude CLI exited with code 129 (SIGHUP: the terminal or console it ran under went away — cezar did not stop it)',
    );
  });

  it('names any other signal exit, and keeps the stderr tail', () => {
    expect(claudeExitMessage(137, 'a\nb')).toBe('claude CLI exited with code 137 (SIGKILL: a signal cezar did not send) — a | b');
  });

  it('leaves an ordinary failure code alone', () => {
    expect(claudeExitMessage(1, 'boom\n')).toBe('claude CLI exited with code 1 — boom');
  });
});

describe('prependSystemPrompt (codex/opencode delivery)', () => {
  it('prepends the prompt as a leading block of the first user message', () => {
    expect(prependSystemPrompt('Extra rules.', 'do it')).toBe('Extra rules.\n\n---\n\ndo it');
  });

  it('leaves the user prompt untouched when no systemPrompt is set', () => {
    expect(prependSystemPrompt(undefined, 'do it')).toBe('do it');
  });
});

describe('ClaudeCliRunner dry-run auth replay', () => {
  it('rejects a manager prompt once and answers its replay with CEZ_HOME unset', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-auth-replay-'));
    const home = join(cwd, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CEZ_HOME', undefined);
    vi.stubEnv('CEZ_CLAUDE_BIN', undefined);
    vi.stubEnv('CEZ_DRY_RUN', '1');

    try {
      const runner = new ClaudeCliRunner({ timeoutMs: 3_000 });
      const spec = { cwd, userPrompt: '[cez-manager:watch]\nmock:auth-error' };
      const firstEvents: AgentEvent[] = [];
      await runner.run(spec, (event) => firstEvents.push(event));
      expect(firstEvents).toContainEqual({
        type: 'error',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });

      const replay = await runner.run(spec);
      expect(replay.text).toBe('MANAGER:QUIET');
      expect(readdirSync(join(home, '.cezar', 'mock-auth-once'))).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

describe('ClaudeCliRunner token usage', () => {
  it('counts the aggregate result usage without re-adding assistant-frame snapshots', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
    const events: AgentEvent[] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-token-usage-'));

    try {
      const result = await runner.run(
        {
          userPrompt: 'fix the login redirect',
          cwd,
          env: {
            CEZ_HANDOFF_FILE: '',
            CEZ_MOCK_ARGS_FILE: '',
            CEZ_TODOS_FILE: '',
          },
          sessionId: '5f701b42-382a-4a6e-b831-0ab9e56eff58',
        },
        (event) => events.push(event),
      );

      // The mock emits four assistant usage snapshots before its aggregate
      // result usage (1,270 input + 185 output). Only the result is authoritative.
      expect(result.tokensUsed).toBe(1_455);
      expect(events.filter((event) => event.type === 'token-usage')).toEqual([
        { type: 'token-usage', tokensUsed: 1_455 },
      ]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

describe('ClaudeCliRunner private MCP (spec 2026-10-07-private-project-mcp)', () => {
  it('spawns with --mcp-config pointing at a 0600 file that is gone once the session ends', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-private-mcp-'));
    const argsFile = join(cwd, 'args.ndjson');
    try {
      await runner.run({
        userPrompt: 'do it',
        cwd,
        env: { CEZ_HANDOFF_FILE: '', CEZ_MOCK_ARGS_FILE: argsFile, CEZ_TODOS_FILE: '' },
        allowedTools: ['Read'],
        mcpServers: [{ name: 'tracker', transport: 'stdio', command: 'tracker-mcp', args: [], env: { TOKEN: 's3cret' }, headers: {} }],
      });
      const argv = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n')[0]!) as string[];
      const configPath = argv[argv.indexOf('--mcp-config') + 1]!;
      expect(argv).toContain('--mcp-config');
      expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('Read,mcp__tracker');
      expect(argv.join(' ')).not.toContain('s3cret');
      expect(existsSync(configPath)).toBe(false);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

describe('a CLI that dies before reading its prompt', () => {
  const stubBin = fileURLToPath(
    new URL('./__fixtures__/claude/stub-exits-before-reading.mjs', import.meta.url),
  );

  // A failed stdin write surfaces as an async 'error' event on the pipe, not a throw; unhandled,
  // it crashed the whole cezar process (seen on a fleet hub when the CLI failed to start).
  it('fails the session instead of crashing the process on EPIPE', async () => {
    const runner = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 });
    const session = runner.startSession(
      { userPrompt: 'x'.repeat(8 * 1024 * 1024), cwd: process.cwd() },
      () => {},
    );
    await expect(session.result).rejects.toThrow('claude CLI exited with code 1');
    // Give a late EPIPE time to surface as an unhandled error, which vitest reports as a failure.
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
});

// Spec 2026-10-24 item 9 (eb4b12dc): a gateway's OpenAI-shaped envelope read as its type and message.
describe('claude result error with a JSON envelope', () => {
  it('shows the vendor error type and message, not the raw JSON', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-envelope-'));
    const bin = join(root, 'claude.mjs');
    const result = 'API Error: 400 [400]: {"error":{"type":"invalid_request_error","message":"model gpt-5 is not available","param":null,"code":null}}';
    writeFileSync(bin, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify({ type: 'result', is_error: true, result }))});\nprocess.exit(1);\n`, { mode: 0o755 });
    try {
      const errors: string[] = [];
      await new ClaudeCliRunner({ bin, timeoutMs: 5000 })
        .run({ cwd: root, userPrompt: 'work' }, (event) => { if (event.type === 'error') errors.push(event.message); })
        .catch(() => undefined);
      expect(errors).toContain('API Error: 400 [400]: invalid_request_error: model gpt-5 is not available');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('system prompt past the Windows command-line limit (#1584)', () => {
  const big = 'x'.repeat(40_000);

  it('spools only on win32 and only when the prompt is large', () => {
    expect(shouldSpoolSystemPrompt(big, 'win32')).toBe(true);
    expect(shouldSpoolSystemPrompt('short', 'win32')).toBe(false);
    expect(shouldSpoolSystemPrompt(big, 'linux')).toBe(false);
    expect(shouldSpoolSystemPrompt(big, 'darwin')).toBe(false);
    expect(writeClaudeSystemPromptFile(big, 'linux')).toBeUndefined();
  });

  it('passes a file flag and keeps the prompt out of argv', () => {
    const file = writeClaudeSystemPromptFile(big, 'win32');
    expect(file).toBeDefined();
    try {
      const args = buildClaudeArgs({ userPrompt: 'do it', cwd: '/tmp', systemPrompt: big }, process.env, undefined, file!.path);
      expect(args).not.toContain('--append-system-prompt');
      expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe(file!.path);
      expect(args.join(' ').length).toBeLessThan(2_000);
      expect(readFileSync(file!.path, 'utf8')).toBe(big);
    } finally {
      file!.cleanup();
    }
  });
});

describe('ClaudeCliRunner connectors (spec 2026-11-12-manager-connectors)', () => {
  const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
  const tool = 'mcp__claude_ai_Google_Calendar__create_event';

  it('reads mcp_servers and tools off system/init, and nothing off other frames', () => {
    expect(claudeMcpServers({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'claude.ai Gmail', status: 'failed' }, { bogus: 1 }], tools: ['Read', 7, 'mcp__a__b'] }))
      .toEqual({ type: 'mcp-servers', servers: [{ name: 'claude.ai Gmail', status: 'failed' }], tools: ['Read', 'mcp__a__b'] });
    expect(claudeMcpServers({ type: 'system', subtype: 'init' })).toBeUndefined();
  });

  it('passes --settings as a path, never the JSON, and only when settings are given', () => {
    const settings = { hooks: { PreToolUse: [] } };
    const args = buildClaudeArgs({ userPrompt: 'x', cwd: '/', claudeSettings: settings }, {}, undefined, undefined, '/tmp/s.json');
    expect(args.slice(args.indexOf('--settings'), args.indexOf('--settings') + 2)).toEqual(['--settings', '/tmp/s.json']);
    expect(args.join(' ')).not.toContain('PreToolUse');
    expect(buildClaudeArgs({ userPrompt: 'x', cwd: '/' }, {}, undefined, undefined, '/tmp/s.json')).not.toContain('--settings');
  });

  it('writes the settings to a 0600 file its cleanup removes', () => {
    const file = writeClaudeSettingsFile({ a: 1 })!;
    try {
      expect(JSON.parse(readFileSync(file.path, 'utf8'))).toEqual({ a: 1 });
      if (process.platform !== 'win32') expect((statSync(file.path).mode & 0o777).toString(8)).toBe('600');
    } finally {
      file.cleanup();
    }
    expect(existsSync(file.path)).toBe(false);
    expect(writeClaudeSettingsFile(undefined)).toBeUndefined();
  });

  const call = async (args: Record<string, unknown>) => {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-connector-'));
    const fence = connectorCallFence(tool, args);
    const events: AgentEvent[] = [];
    try {
      await new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 }).run({
        userPrompt: connectorCallPrompt(tool, args),
        cwd,
        env: { CEZ_HANDOFF_FILE: '', CEZ_MOCK_ARGS_FILE: '', CEZ_TODOS_FILE: '', CEZ_MANAGER_ID: 'm1' },
        allowedTools: [tool],
        claudeSettings: fence.settings,
      }, (event) => events.push(event));
    } finally {
      fence.cleanup();
      rmSync(cwd, { force: true, recursive: true });
    }
    return events;
  };

  it('emits the init servers and lets the approved input through the PreToolUse hook', async () => {
    const events = await call({ summary: 'Kick-Off', when: { start: '2027-01-21' } });
    expect(events.find((event) => event.type === 'mcp-servers')).toMatchObject({
      servers: [{ name: 'claude.ai Google Calendar', status: 'connected' }],
      tools: expect.arrayContaining([tool]),
    });
    expect(events.find((event) => event.type === 'tool-result')).toMatchObject({ isError: false });
  });

  it('denies an input that differs from the approved one', async () => {
    const events = await call({ summary: 'mock:tamper' });
    const result = events.find((event) => event.type === 'tool-result');
    expect(result).toMatchObject({ isError: true });
    expect(result?.type === 'tool-result' && result.result).toContain('differs from the one the user approved');
  });
});

// Claude's result totals are session-wide running sums; each turn reports only its own share.
describe('per-turn cost from a session running total', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-claude-turn-cost-'));
  });
  afterEach(() => {
    resetClaudeSessionCosts();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports each result as an increment, in v1 cost and v2 turn usage alike', async () => {
    const stubBin = join(dir, 'claude-two-turns.mjs');
    const result = (total: number, input: number) => JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'unpinned-1',
      total_cost_usd: total, usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: { 'claude-opus-5-5': { inputTokens: input, outputTokens: 2, costUSD: total, contextWindow: 200000 } },
    });
    writeFileSync(stubBin, `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'unpinned-1', model: 'claude-opus-5-5' }));
console.log(${JSON.stringify(result(0.5, 10))});
console.log(${JSON.stringify(result(1.25, 30))});
`, { mode: 0o700 });
    const events: AgentEvent[] = [];
    const uiEvents: UiEvent[] = [];
    const session = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 }).startSession(
      { userPrompt: 'go', cwd: dir },
      (event) => events.push(event),
      { onUiEvent: (event) => uiEvents.push(event) },
    );
    await session.result;

    expect(events.flatMap((e) => (e.type === 'cost' ? [e.usd] : []))).toEqual([0.5, 0.75]);
    const models = uiEvents.flatMap((e) => (e.type === 'turn.completed' ? [e.models?.[0]] : []));
    expect(models).toEqual([
      { model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 2, costUsd: 0.5 },
      { model: 'claude-opus-5-5', inputTokens: 20, outputTokens: 0, costUsd: 0.75 },
    ]);
    // The session is now known: a resume in this process diffs against its last total.
    expect(new ClaudeSessionCost('unpinned-1', true, dir, undefined).increment(2)).toBeCloseTo(0.75);
  }, 15_000);
});
