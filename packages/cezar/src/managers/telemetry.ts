import type { Manager, ManagerActionRequest, ManagerTurnKind, UpdateManagerInput } from '@open-mercato/cezar-contract';
import { isRunnerId } from '../core/agent-runner.ts';
import { isBuiltInWorkflowName } from '../feature-telemetry.ts';

/**
 * The server half of Manager mode's telemetry (docs/telemetry.md, PR #2038). Every label is built
 * here from a closed vocabulary — a manager's name, instructions, projects, prompts and replies
 * never reach one. One label per event (the tracking guide's rule), so several facts are joined
 * by `:`; durations are timings, never label buckets.
 */

export type ManagerTelemetryEvent =
  | 'manager_created'
  | 'manager_deleted'
  | 'manager_settings_changed'
  | 'manager_turn_completed'
  | 'manager_task_started'
  | 'manager_action_proposed'
  | 'manager_action_decided';

export interface ManagerTelemetry {
  track: (event: ManagerTelemetryEvent, label: string, opts?: { sid?: string }) => void;
  timing: (name: 'manager_turn' | 'manager_action_decision', durationMs: number, fields: { operation: string; target: string; outcome: 'ok' | 'error' | 'timeout' }) => void;
}

/** Who asked, when a cockpit did: the device id keys the event so a goal joins it to the tab's own. */
export interface ManagerTelemetryContext {
  sid?: string | undefined;
}

const runnerLabel = (runner: string | undefined): string => (runner !== undefined && isRunnerId(runner) ? runner : 'default');

/** `<first_manager>:<projects>:<watch>:<runner>`, e.g. `yes:all:on:claude`. */
export function managerCreatedLabel(manager: Pick<Manager, 'projects' | 'cronMinutes' | 'runner'>, first: boolean): string {
  return [first ? 'yes' : 'no', manager.projects === 'all' ? 'all' : 'some', manager.cronMinutes > 0 ? 'on' : 'off', runnerLabel(manager.runner)].join(':');
}

const DAY_MS = 86_400_000;

export function managerAgeLabel(createdAt: string, now: number): '0' | '1-6' | '7-29' | '30+' {
  const created = Date.parse(createdAt);
  const days = Number.isFinite(created) ? Math.floor(Math.max(0, now - created) / DAY_MS) : 0;
  if (days < 1) return '0';
  if (days < 7) return '1-6';
  if (days < 30) return '7-29';
  return '30+';
}

export const MANAGER_SETTING_FIELDS = ['watch', 'runner', 'model', 'notify', 'projects', 'jobs', 'persona'] as const;
export type ManagerSettingField = (typeof MANAGER_SETTING_FIELDS)[number];

const FIELD_OF: Record<keyof UpdateManagerInput, ManagerSettingField> = {
  cronMinutes: 'watch',
  runner: 'runner',
  agentProfile: 'runner',
  model: 'model',
  effort: 'model',
  notify: 'notify',
  projects: 'projects',
  access: 'projects',
  projectAccess: 'projects',
  jobs: 'jobs',
  name: 'persona',
  avatar: 'persona',
  mascot: 'persona',
  instructions: 'persona',
};

/** The groups whose stored value really changed — a save that repeats a value counts nothing. */
export function changedSettingFields(before: Manager, after: Manager): ManagerSettingField[] {
  const changed = new Set<ManagerSettingField>();
  for (const [key, field] of Object.entries(FIELD_OF) as Array<[keyof UpdateManagerInput & keyof Manager, ManagerSettingField]>) {
    // Jobs carry a `lastRunAt` the engine stamps on save; only what the user edits counts.
    const read = (manager: Manager) => (key === 'jobs'
      ? manager.jobs.map(({ lastRunAt: _lastRunAt, ...job }) => job)
      : manager[key]);
    if (JSON.stringify(read(before)) !== JSON.stringify(read(after))) changed.add(field);
  }
  return MANAGER_SETTING_FIELDS.filter((field) => changed.has(field));
}

export function managerActionLabel(action: Pick<ManagerActionRequest, 'type'>): 'merge' | 'automation' | 'job' {
  return action.type === 'merge-pr' ? 'merge' : action.type === 'enable-automation' ? 'automation' : 'job';
}

export function managerWorkflowLabel(workflow: string | undefined): 'builtin' | 'custom' {
  return workflow === undefined || isBuiltInWorkflowName(workflow) ? 'builtin' : 'custom';
}

export const MANAGER_TURN_TRIGGER: Record<ManagerTurnKind, 'user' | 'watch' | 'job'> = { chat: 'user', watch: 'watch', job: 'job' };
