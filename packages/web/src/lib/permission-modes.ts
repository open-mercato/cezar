/**
 * Permission mode presets (spec 2026-07-17-permission-modes, #475).
 * Shared by Settings → Agents and the new-task composer pill.
 */

export type PermissionMode = 'auto' | 'guarded' | 'read-only' | 'manual'

/** Composer/Settings choice including the unset historical workspace default. */
export type PermissionChoice = PermissionMode | 'default'

export const PERMISSION_SPECIFIER_RE = /^[A-Za-z][A-Za-z0-9_-]*(\(.+\))?$/

export const PERMISSION_MODES: ReadonlyArray<{
  id: PermissionMode
  label: string
  desc: string
  /** Short phrase used in the autonomous-conflict copy ("shell commands and network access"). */
  askWhat: string
}> = [
  {
    id: 'auto',
    label: 'Auto',
    desc: 'Full unrestricted access — skip every permission check. Opt-in; not the zero-config default.',
    askWhat: '',
  },
  {
    id: 'guarded',
    label: 'Guarded',
    desc: 'Edits run automatically; shell commands and network access ask first.',
    askWhat: 'shell commands and network access',
  },
  {
    id: 'read-only',
    label: 'Read-only',
    desc: 'The agent may read the repo; any change or command asks first.',
    askWhat: 'any change or command',
  },
  {
    id: 'manual',
    label: 'Manual',
    desc: 'Every tool use asks first.',
    askWhat: 'every tool use',
  },
]

export const DEFAULT_PERMISSION_PRESET = {
  id: 'default' as const,
  label: 'Default',
  desc: 'Historical workspace posture: Claude coding tools run, anything else is denied without asking. Codex and OpenCode stay unrestricted.',
  askWhat: '',
}

export function permissionModeLabel(mode: PermissionChoice): string {
  if (mode === 'default') return DEFAULT_PERMISSION_PRESET.label
  return PERMISSION_MODES.find((m) => m.id === mode)?.label ?? mode
}

export function isPermissionMode(value: string): value is PermissionMode {
  return PERMISSION_MODES.some((m) => m.id === value)
}

export function isPermissionChoice(value: string): value is PermissionChoice {
  return value === 'default' || isPermissionMode(value)
}

/** Parse one-specifiers-per-line textareas. Illegal lines are returned separately so Save can refuse. */
export function parsePermissionRulesText(text: string): { rules?: string[]; invalid: string[] } {
  const rules: string[] = []
  const invalid: string[] = []
  for (const line of text.split('\n').map((item) => item.trim()).filter(Boolean)) {
    if (line.length <= 200 && PERMISSION_SPECIFIER_RE.test(line)) rules.push(line)
    else invalid.push(line)
  }
  return { rules: rules.length > 0 ? rules : undefined, invalid }
}

export function formatPermissionRulesText(rules: string[] | undefined): string {
  return (rules ?? []).join('\n')
}
