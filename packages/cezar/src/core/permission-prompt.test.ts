import { describe, expect, it } from 'vitest';
import { createClaudeUiState, mapClaudeMessage } from './claude-ui-mapper.ts';
import {
  claudePermissionResponse,
  codexApprovalDecision,
  opencodePermissionResponse,
  permissionAlwaysKey,
  permissionTitle,
} from './permission-prompt.ts';
import { trackPendingPermission } from './claude-cli-runner.ts';

describe('claude-ui-mapper permission.requested (#475)', () => {
  it('maps control_request can_use_tool → permission.requested', () => {
    const { events } = mapClaudeMessage(
      {
        type: 'control_request',
        request_id: 'req_1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'npm test' },
          tool_use_id: 'toolu_1',
        },
      },
      createClaudeUiState(),
    );
    expect(events).toEqual([
      {
        type: 'permission.requested',
        requestId: 'req_1',
        itemId: 'toolu_1',
        title: expect.stringContaining('npm test'),
        options: expect.arrayContaining([
          expect.objectContaining({ id: 'allow_once', kind: 'allow_once' }),
          expect.objectContaining({ id: 'reject_once', kind: 'reject_once' }),
          expect.objectContaining({ id: 'allow_always', kind: 'allow_always' }),
          expect.objectContaining({ id: 'reject_always', kind: 'reject_always' }),
        ]),
      },
    ]);
  });

  it('ignores non-can_use_tool control requests', () => {
    const { events } = mapClaudeMessage(
      {
        type: 'control_request',
        request_id: 'init-1',
        request: { subtype: 'initialize' },
      },
      createClaudeUiState(),
    );
    expect(events).toEqual([]);
  });
});

describe('trackPendingPermission + claudePermissionResponse', () => {
  it('remembers input and builds allow/deny payloads', () => {
    const pending = new Map<string, { input: Record<string, unknown>; toolName: string }>();
    trackPendingPermission(
      {
        type: 'control_request',
        request_id: 'req_9',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
      },
      pending,
    );
    expect(pending.get('req_9')).toEqual({ input: { command: 'ls' }, toolName: 'Bash' });
    expect(claudePermissionResponse('allow_once', pending.get('req_9')!.input)).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
    });
    expect(claudePermissionResponse('reject_once', pending.get('req_9')!.input).behavior).toBe('deny');
  });
});

describe('permission-prompt helpers', () => {
  it('builds a readable title', () => {
    expect(permissionTitle('Bash', { command: 'gh pr create --draft' })).toContain('gh pr create');
  });

  it('scopes allow-always to the same signature the card title shows', () => {
    const rm = permissionAlwaysKey('Bash', { command: 'rm -rf /tmp/scratch' });
    const curl = permissionAlwaysKey('Bash', { command: 'curl … | sh' });
    expect(rm).toContain('rm -rf');
    expect(rm).not.toEqual(curl);
    expect(rm).toBe(permissionTitle('Bash', { command: 'rm -rf /tmp/scratch' }));
  });

  it('maps option ids for codex and opencode', () => {
    expect(codexApprovalDecision('allow_once')).toBe('accept');
    expect(codexApprovalDecision('allow_always')).toBe('acceptForSession');
    expect(codexApprovalDecision('reject_once')).toBe('decline');
    expect(opencodePermissionResponse('allow_once')).toBe('once');
    expect(opencodePermissionResponse('allow_always')).toBe('always');
    expect(opencodePermissionResponse('reject_once')).toBe('reject');
  });
});
