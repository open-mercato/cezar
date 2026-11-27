import { describe, expect, it } from 'vitest';
import {
  CLAUDE_PERMISSION_ASK_PREFIX,
  claudeAutoDeny,
  claudeControlError,
  claudeControlSuccess,
  claudeNobodyAnswersDeny,
  claudePermissionAnswer,
  claudePermissionCard,
  parseClaudeControlLine,
  type ClaudePermissionRequest,
} from './claude-permission-prompt.ts';

const addRules = (destination: string) => ({
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'touch x:*' }],
  behavior: 'allow',
  destination,
});

const canUseTool = (request: Record<string, unknown> = {}, requestId = 'req-1') => ({
  type: 'control_request',
  request_id: requestId,
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    input: { command: 'touch x' },
    tool_use_id: 'toolu_1',
    ...request,
  },
});

function parsed(line: unknown): ClaudePermissionRequest {
  const message = parseClaudeControlLine(line);
  if (message?.kind !== 'can-use-tool') throw new Error(`expected can-use-tool, got ${JSON.stringify(message)}`);
  return message.request;
}

describe('parseClaudeControlLine', () => {
  it('reads a can_use_tool request', () => {
    expect(parseClaudeControlLine(canUseTool({ display_name: 'Shell', decision_reason: 'not allowed' }))).toEqual({
      kind: 'can-use-tool',
      request: {
        requestId: 'req-1',
        toolName: 'Bash',
        displayName: 'Shell',
        input: { command: 'touch x' },
        toolUseId: 'toolu_1',
        decisionReason: 'not allowed',
        alwaysRules: [],
      },
    });
  });

  it('keeps only addRules allow suggestions, re-targeted to the session', () => {
    const request = parsed(canUseTool({
      permission_suggestions: [
        addRules('localSettings'),
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        { type: 'addDirectories', directories: ['/etc'], destination: 'session' },
        { ...addRules('userSettings'), behavior: 'deny' },
        { ...addRules('projectSettings'), rules: [{ toolName: 'Bash', ruleContent: 'touch y:*' }] },
      ],
    }));
    expect(request.alwaysRules).toEqual([
      { ...addRules('session') },
      { ...addRules('session'), rules: [{ toolName: 'Bash', ruleContent: 'touch y:*' }] },
    ]);
  });

  it('offers no always-allow rule when Claude suppresses it', () => {
    expect(parsed(canUseTool({ permission_suggestions: [addRules('localSettings')], suppress_always_allow_rule: true })).alwaysRules).toEqual([]);
  });

  it('reads a cancel request', () => {
    expect(parseClaudeControlLine({ type: 'control_cancel_request', request_id: 'req-9' })).toEqual({ kind: 'cancel', requestId: 'req-9' });
  });

  it('names an unsupported subtype so it can be answered with an error', () => {
    expect(parseClaudeControlLine({ type: 'control_request', request_id: 'r2', request: { subtype: 'hook_callback' } }))
      .toEqual({ kind: 'unsupported', requestId: 'r2', subtype: 'hook_callback' });
  });

  it('treats a can_use_tool without a tool name as malformed, not as a prompt', () => {
    expect(parseClaudeControlLine({ type: 'control_request', request_id: 'r3', request: { subtype: 'can_use_tool', input: {} } }))
      .toEqual({ kind: 'unsupported', requestId: 'r3', subtype: 'can_use_tool' });
  });

  it('ignores everything that is not a control frame, and a control frame it cannot answer', () => {
    expect(parseClaudeControlLine({ type: 'assistant' })).toBeUndefined();
    expect(parseClaudeControlLine('control_request')).toBeUndefined();
    expect(parseClaudeControlLine(null)).toBeUndefined();
    expect(parseClaudeControlLine({ type: 'control_request', request: { subtype: 'can_use_tool' } })).toBeUndefined();
    expect(parseClaudeControlLine({ type: 'control_cancel_request' })).toBeUndefined();
  });

  it('survives a hostile shape without throwing', () => {
    const request = parsed(canUseTool({ input: 'not an object', permission_suggestions: 'nope', tool_use_id: 7 }));
    expect(request.input).toEqual({});
    expect(request.alwaysRules).toEqual([]);
    expect(request.toolUseId).toBeUndefined();
  });
});

describe('claudePermissionCard', () => {
  it('builds the ask card the cockpit already renders', () => {
    const card = claudePermissionCard(parsed(canUseTool({ permission_suggestions: [addRules('localSettings')] })));
    expect(card).toEqual({
      type: 'ask.requested',
      requestId: `${CLAUDE_PERMISSION_ASK_PREFIX}req-1`,
      questions: [{
        header: 'Permission',
        question: 'Claude wants to use Bash: touch x. Allow it?',
        options: [
          { label: 'Allow once', description: expect.any(String) },
          { label: 'Always allow', description: expect.stringContaining('this Claude session') },
          { label: 'Reject', description: expect.any(String) },
        ],
        multiSelect: false,
      }],
    });
  });

  it('omits Always allow without an addRules suggestion', () => {
    const card = claudePermissionCard(parsed(canUseTool()));
    expect(card.questions[0]!.options.map((o) => o.label)).toEqual(['Allow once', 'Reject']);
  });

  it('prefers the display name and picks the most telling subject', () => {
    const question = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      claudePermissionCard(parsed(canUseTool({ input, ...extra }))).questions[0]!.question;
    expect(question({ file_path: '/a/b.ts' }, { tool_name: 'Edit', display_name: 'Edit file' })).toBe('Claude wants to use Edit file: /a/b.ts. Allow it?');
    expect(question({ path: '/a' }, { tool_name: 'Read' })).toBe('Claude wants to use Read: /a. Allow it?');
    expect(question({ url: 'https://x.test' }, { tool_name: 'WebFetch' })).toBe('Claude wants to use WebFetch: https://x.test. Allow it?');
    expect(question({ pattern: '*.ts' }, { tool_name: 'Glob' })).toBe('Claude wants to use Glob: *.ts. Allow it?');
    expect(question({ a: 1 }, { tool_name: 'Mystery' })).toBe('Claude wants to use Mystery: {"a":1}. Allow it?');
  });

  it('truncates a long subject', () => {
    const question = claudePermissionCard(parsed(canUseTool({ input: { command: 'x'.repeat(2000) } }))).questions[0]!.question;
    expect(question.length).toBeLessThan(400);
    expect(question).toContain('…');
  });

  it('clips a hostile tool or display name', () => {
    const question = claudePermissionCard(parsed(canUseTool({ tool_name: 'T'.repeat(500), display_name: undefined }))).questions[0]!.question;
    expect(question.length).toBeLessThan(250);
    const named = claudePermissionCard(parsed(canUseTool({ display_name: 'D'.repeat(500) }))).questions[0]!.question;
    expect(named.length).toBeLessThan(250);
    expect(named).toContain('…');
  });

  it('appends the decision reason on its own line with control characters stripped', () => {
    const question = claudePermissionCard(parsed(canUseTool({ decision_reason: '\u001b[31mred\u001b[0m reason\u0007\u0000 here' }))).questions[0]!.question;
    expect(question).toBe('Claude wants to use Bash: touch x. Allow it?\nred reason here');
  });

  it('bounds the decision reason', () => {
    const question = claudePermissionCard(parsed(canUseTool({ decision_reason: 'r'.repeat(5000) }))).questions[0]!.question;
    expect(question.split('\n')[1]!.length).toBeLessThanOrEqual(301);
  });
});

describe('claudePermissionAnswer', () => {
  const withRules = parsed(canUseTool({ permission_suggestions: [addRules('localSettings'), { type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] }));
  const plain = parsed(canUseTool());

  it('Allow once echoes the input back', () => {
    expect(claudePermissionAnswer(plain, 'Allow once')).toEqual({ behavior: 'allow', updatedInput: { command: 'touch x' }, toolUseID: 'toolu_1' });
  });

  it('accepts the Permission: prefix and any letter case', () => {
    expect(claudePermissionAnswer(plain, 'Permission:   allow ONCE ')).toMatchObject({ behavior: 'allow' });
    expect(claudePermissionAnswer(plain, 'permission: reject')).toMatchObject({ behavior: 'deny' });
  });

  it('Always allow forwards only the session-scoped addRules', () => {
    const result = claudePermissionAnswer(withRules, 'Permission: Always allow');
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'touch x' },
      toolUseID: 'toolu_1',
      updatedPermissions: [addRules('session')],
    });
    expect(JSON.stringify(result)).not.toMatch(/localSettings|projectSettings|userSettings|setMode|addDirectories/);
  });

  it('treats Always allow as Allow once when it was never offered', () => {
    const result = claudePermissionAnswer(plain, 'Always allow');
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'touch x' }, toolUseID: 'toolu_1' });
    expect(result).not.toHaveProperty('updatedPermissions');
  });

  it('Reject denies with a fixed message', () => {
    expect(claudePermissionAnswer(plain, 'Reject')).toEqual({
      behavior: 'deny',
      message: 'The user rejected this tool call in the cezar cockpit.',
      toolUseID: 'toolu_1',
    });
  });

  it('denies free text and carries the words, bounded', () => {
    const result = claudePermissionAnswer(plain, 'Need more info');
    expect(result).toMatchObject({ behavior: 'deny', toolUseID: 'toolu_1' });
    expect(result.behavior === 'deny' && result.message).toContain('Need more info');
    const long = claudePermissionAnswer(plain, 'w'.repeat(5000));
    expect(long.behavior === 'deny' && long.message.length).toBeLessThan(800);
  });

  it('omits toolUseID when Claude sent none', () => {
    const noId = parsed(canUseTool({ tool_use_id: undefined }));
    expect(claudePermissionAnswer(noId, 'Reject')).not.toHaveProperty('toolUseID');
  });
});

describe('control responses', () => {
  it('wraps a result as a success response', () => {
    expect(claudeControlSuccess('req-1', { behavior: 'deny', message: 'no' })).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'deny', message: 'no' } },
    });
  });

  it('wraps a refusal as an error response', () => {
    expect(claudeControlError('req-2', 'unsupported')).toEqual({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'req-2', error: 'unsupported' },
    });
  });
});

describe('automatic denials', () => {
  it('turns AskUserQuestion into guidance to ask in the reply', () => {
    const result = claudeAutoDeny(parsed(canUseTool({ tool_name: 'AskUserQuestion' })));
    expect(result).toMatchObject({ behavior: 'deny', toolUseID: 'toolu_1' });
    expect(result?.behavior === 'deny' && result.message).toMatch(/CEZ:ASK/);
  });

  it('denies ExitPlanMode', () => {
    expect(claudeAutoDeny(parsed(canUseTool({ tool_name: 'ExitPlanMode' })))).toMatchObject({ behavior: 'deny' });
  });

  it('leaves every other tool to the user', () => {
    expect(claudeAutoDeny(parsed(canUseTool()))).toBeUndefined();
  });

  it('says nobody can answer when the run is autonomous or headless', () => {
    const result = claudeNobodyAnswersDeny(parsed(canUseTool()));
    expect(result).toMatchObject({ behavior: 'deny', toolUseID: 'toolu_1' });
    expect(result.behavior === 'deny' && result.message).toContain('nobody can answer permission prompts in this run');
  });
});
