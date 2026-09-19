import { describe, expect, it } from 'vitest';
import {
  mergePermissionSpecs,
  remapClaudePermissionMode,
  translateClaudePermissions,
  translateCodexPermissions,
  translateOpencodePermissions,
  type PermissionSpec,
} from './permission-map.ts';

describe('translateClaudePermissions', () => {
  it('auto → dangerously-skip-permissions (full unrestricted)', () => {
    const out = translateClaudePermissions({ mode: 'auto' });
    expect(out.dangerouslySkipPermissions).toBe(true);
    expect(out.permissionMode).toBeUndefined();
    expect(out.additionalAllowedTools).toEqual([]);
    expect(out.disallowedTools).toEqual([]);
    expect(out.settingsJson).toBeUndefined();
  });

  it('guarded → acceptEdits with Bash in ask settings', () => {
    const out = translateClaudePermissions({ mode: 'guarded' });
    expect(out.dangerouslySkipPermissions).toBe(false);
    expect(out.permissionMode).toBe('acceptEdits');
    expect(out.settingsJson).toBe(JSON.stringify({ permissions: { ask: ['Bash'] } }));
  });

  it('read-only → manual + Read/Grep/Glob allowlist (prompt mode; remapped to `default` on CLIs that dropped `manual`)', () => {
    const out = translateClaudePermissions({ mode: 'read-only' });
    expect(out.permissionMode).toBe('manual');
    expect(out.additionalAllowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(out.settingsJson).toContain('Bash');
    expect(out.permissionPromptToolStdio).toBe(true);
  });

  it('manual → manual with empty allowlist (everything prompts)', () => {
    const out = translateClaudePermissions({ mode: 'manual' });
    expect(out.permissionMode).toBe('manual');
    expect(out.additionalAllowedTools).toEqual([]);
    expect(out.dangerouslySkipPermissions).toBe(false);
    expect(out.permissionPromptToolStdio).toBe(true);
  });

  it('merges advanced allow/deny/ask rules', () => {
    const out = translateClaudePermissions({
      mode: 'guarded',
      rules: {
        allow: ['Bash(git *)'],
        ask: ['WebFetch'],
        deny: ['Bash(rm *)'],
      },
    });
    expect(out.additionalAllowedTools).toEqual(['Bash(git *)']);
    expect(out.disallowedTools).toEqual(['Bash(rm *)']);
    expect(out.settingsJson).toBe(JSON.stringify({ permissions: { ask: ['Bash', 'WebFetch'] } }));
  });
});

describe('remapClaudePermissionMode', () => {
  it('keeps manual when the CLI advertises it', () => {
    expect(remapClaudePermissionMode('manual', new Set(['manual', 'acceptEdits']))).toBe('manual');
  });

  it('rewrites manual → default when the CLI only lists default', () => {
    expect(
      remapClaudePermissionMode(
        'manual',
        new Set(['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan']),
      ),
    ).toBe('default');
  });
});

describe('mergePermissionSpecs', () => {
  it('keeps config deny rules when a per-task mode override has no rules', () => {
    const merged = mergePermissionSpecs(
      { mode: 'read-only' },
      { mode: 'auto', rules: { deny: ['Bash(rm *)'] } },
    );
    expect(merged).toEqual({ mode: 'read-only', rules: { deny: ['Bash(rm *)'] } });
  });

  it('returns undefined when both sides are absent (historical default, not auto)', () => {
    expect(mergePermissionSpecs(undefined, undefined)).toBeUndefined();
  });
});

describe('translateCodexPermissions', () => {
  it('maps each preset to sandbox + approvalPolicy', () => {
    expect(translateCodexPermissions({ mode: 'auto' })).toEqual({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      engineNote: null,
    });
    expect(translateCodexPermissions({ mode: 'guarded' })).toEqual({
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      engineNote: null,
    });
    expect(translateCodexPermissions({ mode: 'read-only' })).toEqual({
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      engineNote: null,
    });
    expect(translateCodexPermissions({ mode: 'manual' })).toEqual({
      sandbox: 'read-only',
      approvalPolicy: {
        granular: {
          sandbox_approval: true,
          rules: true,
          skill_approval: true,
          request_permissions: true,
          mcp_elicitations: true,
        },
      },
      engineNote: null,
    });
  });

  it('notes that advanced rules are ignored', () => {
    const out = translateCodexPermissions({
      mode: 'guarded',
      rules: { allow: ['Bash(git *)'] },
    });
    expect(out.sandbox).toBe('workspace-write');
    expect(out.engineNote).toMatch(/not supported by codex/);
    expect(out.engineNote).toMatch(/guarded/);
  });
});

describe('translateOpencodePermissions', () => {
  it('maps each preset to OpenCode Ruleset array (not object syntax)', () => {
    expect(translateOpencodePermissions({ mode: 'auto' }).permissions).toEqual([
      { permission: 'bash', pattern: '*', action: 'allow' },
      { permission: 'edit', pattern: '*', action: 'allow' },
      { permission: 'webfetch', pattern: '*', action: 'allow' },
      { permission: 'read', pattern: '*', action: 'allow' },
    ]);
    expect(translateOpencodePermissions({ mode: 'guarded' }).permissions).toEqual([
      { permission: 'edit', pattern: '*', action: 'allow' },
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'webfetch', pattern: '*', action: 'ask' },
      { permission: 'read', pattern: '*', action: 'allow' },
    ]);
    expect(translateOpencodePermissions({ mode: 'read-only' }).permissions).toEqual([
      { permission: 'edit', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'webfetch', pattern: '*', action: 'ask' },
      { permission: 'read', pattern: '*', action: 'allow' },
    ]);
    expect(translateOpencodePermissions({ mode: 'manual' }).permissions).toEqual([
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'edit', pattern: '*', action: 'ask' },
      { permission: 'webfetch', pattern: '*', action: 'ask' },
      { permission: 'read', pattern: '*', action: 'ask' },
    ]);
  });

  it('applies recognised advanced rules and notes unrecognised ones', () => {
    const spec: PermissionSpec = {
      mode: 'auto',
      rules: {
        allow: ['Bash(git *)'],
        ask: ['WebFetch'],
        deny: ['TotallyFakeTool'],
      },
    };
    const out = translateOpencodePermissions(spec);
    expect(out.permissions).toContainEqual({ permission: 'bash', pattern: 'git *', action: 'allow' });
    expect(out.permissions).toContainEqual({ permission: 'webfetch', pattern: '*', action: 'ask' });
    expect(out.engineNote).toMatch(/TotallyFakeTool/);
  });
});
