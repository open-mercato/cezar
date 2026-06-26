import type { TriageTrigger } from './run-triage-pass-job';

/**
 * Map a GitHub `issues` webhook action to the `TriageTrigger` carried in the
 * enqueued job payload (Phase 4 — trigger honesty), so the triage pass matches
 * actions on what actually happened.
 *
 *   - `reopened` → `'on-issue-reopened'`
 *   - `edited`   → `'on-issue-edited'`
 *   - anything else (notably `opened`) → `'on-issue-opened'`
 */
export function deriveTriageTrigger(action: string): TriageTrigger {
  if (action === 'reopened') return 'on-issue-reopened';
  if (action === 'edited') return 'on-issue-edited';
  return 'on-issue-opened';
}
