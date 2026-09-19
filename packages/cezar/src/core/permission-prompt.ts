/**
 * Shared helpers for mapping a backend's native approval request onto the
 * protocol-v2 `permission.requested` / `permission.resolved` events (#475).
 */

import type { PermissionOption, PermissionOptionKind } from './ui-events.ts';
import { toolDisplay } from './tool-display.ts';

const OPTION: Record<PermissionOptionKind, PermissionOption> = {
  allow_once: { id: 'allow_once', label: 'Allow once', kind: 'allow_once' },
  allow_always: { id: 'allow_always', label: 'Allow always', kind: 'allow_always' },
  reject_once: { id: 'reject_once', label: 'Reject once', kind: 'reject_once' },
  reject_always: { id: 'reject_always', label: 'Reject always', kind: 'reject_always' },
};

/** Claude / Codex minimum: once allow + once reject. */
export const PERMISSION_OPTIONS_ONCE: readonly PermissionOption[] = [
  OPTION.allow_once,
  OPTION.reject_once,
];

/** Claude / Codex when the backend supports session-scoped always. */
export const PERMISSION_OPTIONS_WITH_ALWAYS: readonly PermissionOption[] = [
  OPTION.allow_once,
  OPTION.allow_always,
  OPTION.reject_once,
  OPTION.reject_always,
];

/** OpenCode's reply surface: once / always / reject (no reject_always). */
export const PERMISSION_OPTIONS_CODEX: readonly PermissionOption[] = [
  OPTION.allow_once,
  OPTION.allow_always,
  OPTION.reject_once,
];

/** Human title for a permission card — `Bash · npm test`, truncated via toolDisplay. */
export function permissionTitle(toolName: string, input: unknown): string {
  const display = toolDisplay(toolName, input);
  const detail = display.subtitle ?? summariseInput(input);
  return detail ? `${display.title} · ${detail}` : display.title;
}

function summariseInput(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      const collapsed = value.replace(/\s+/g, ' ').trim();
      return collapsed.length > 120 ? `${collapsed.slice(0, 119)}…` : collapsed;
    }
    if (Array.isArray(value)) {
      const argv = value.filter((part): part is string => typeof part === 'string');
      if (argv.length > 0) {
        const joined = argv.join(' ');
        return joined.length > 120 ? `${joined.slice(0, 119)}…` : joined;
      }
    }
  }
  return undefined;
}

/** Map an option id to Claude's `can_use_tool` control_response payload. */
export function claudePermissionResponse(
  optionId: string,
  input: Record<string, unknown>,
): { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string } {
  if (optionId === 'allow_once' || optionId === 'allow_always') {
    return { behavior: 'allow', updatedInput: input };
  }
  return {
    behavior: 'deny',
    message: optionId === 'reject_always' ? 'Rejected for this session' : 'Rejected once',
  };
}

/** Map an option id to Codex's requestApproval decision string. */
export function codexApprovalDecision(optionId: string): string | undefined {
  switch (optionId) {
    case 'allow_once':
      return 'accept';
    case 'allow_always':
      return 'acceptForSession';
    case 'reject_once':
    case 'reject_always':
      return 'decline';
    default:
      return undefined;
  }
}

/** Map an option id to OpenCode's permissions endpoint `response` value. */
export function opencodePermissionResponse(optionId: string): 'once' | 'always' | 'reject' | undefined {
  switch (optionId) {
    case 'allow_once':
      return 'once';
    case 'allow_always':
      return 'always';
    case 'reject_once':
    case 'reject_always':
      return 'reject';
    default:
      return undefined;
  }
}

/** Outcome line the cockpit shows after resolve. */
export function permissionOutcomeLabel(optionId: string | undefined, cancelled?: boolean): string {
  if (cancelled) return 'cancelled';
  switch (optionId) {
    case 'allow_once':
      return 'allowed once';
    case 'allow_always':
      return 'allowed always';
    case 'reject_once':
      return 'rejected once';
    case 'reject_always':
      return 'rejected always';
    default:
      return 'resolved';
  }
}
