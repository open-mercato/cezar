/**
 * Whether a project's opt-in `bypassPermissions` is honored on this machine. One answer for the
 * run (which falls back to `dontAsk`) and for Settings (which shows the reason).
 */
import type { CezConfig } from './config.ts';
import { isLifecycleConfigTracked } from './worktree-lifecycle/config.ts';

export const BYPASS_PERMISSIONS_HOSTED =
  'skipping permission prompts is local-only: a hosted cockpit cannot turn approvals off';
export const BYPASS_PERMISSIONS_TRACKED =
  'skipping permission prompts is off: .ai/cezar/config.json is tracked by git, and only local configuration can grant it';
export const BYPASS_PERMISSIONS_ROOT =
  'skipping permission prompts is off: cezar runs as root, and Claude Code refuses to skip them for root';

/** Why the setting is not honored here, or null — also null when it is off. */
export async function bypassPermissionsBlocked(
  repoRoot: string,
  config: Pick<CezConfig, 'bypassPermissions'>,
  { hosted = false, uid = process.getuid?.() }: { hosted?: boolean; uid?: number } = {},
): Promise<string | null> {
  if (config.bypassPermissions !== true) return null;
  // Like agent-config writes: a hosted operator may rely on Claude's own sandbox to contain agents.
  if (hosted) return BYPASS_PERMISSIONS_HOSTED;
  // Claude exits on bypass mode as root, so every task would fail instead of asking.
  if (uid === 0) return BYPASS_PERMISSIONS_ROOT;
  if (await isLifecycleConfigTracked(repoRoot).catch(() => true)) return BYPASS_PERMISSIONS_TRACKED;
  return null;
}
