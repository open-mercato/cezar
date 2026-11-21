/**
 * The registry of what a manager may propose (spec 2026-11-20-manager-admin-actions § 2.1). Each
 * proposal type declares how it is checked, stamped, performed and found stale in one place; the
 * engine's `propose` and `decide` run every type through the same path. Phase 0 holds the four
 * types that existed before the registry, with their behaviour unchanged.
 */
import type {
  AutomationDefinition,
  Manager,
  ManagerActionCategory,
  ManagerActionOp,
  ManagerActionRequest,
  ManagerActionRisk,
  ManagerJob,
} from '@open-mercato/cezar-contract';
import { managerAccessOf, managerConnectorToolMode } from '@open-mercato/cezar-contract';
import { createHash } from 'node:crypto';
import { canonicalJson, connectorToolName } from './connectors.ts';

export type ManagerActionType = ManagerActionRequest['type'];
type ActionOf<T extends ManagerActionType> = Extract<ManagerActionRequest, { type: T }>;
export interface ActionRefusal { error: string; status: 400 | 403 | 404 | 409 | 502 }
export interface ActionOutcome { ok: boolean; result: string; dismissed?: boolean }

/** What an op may use of the engine: in-process routes and the manager's own state, nothing else. */
export interface ActionContext {
  managerId: string;
  forward(path: string, init?: { method: string; body?: unknown }): Promise<Response>;
  refusalOf(response: Response): Promise<ActionRefusal>;
  /** Claude's display name for a connector key, from the last observed session. */
  connectorName(connector: string): string;
  /** `merged`/`closed` as the forge says now, or `undefined` while open or unknown. */
  prState(projectId: string, number: number): Promise<'merged' | 'closed' | undefined>;
  runner(): Promise<string>;
  addJob(input: Omit<ManagerJob, 'id'>): ManagerJob | ActionRefusal;
  callConnector(action: ActionOf<'connector-call'>): Promise<ActionOutcome>;
  iso(): string;
}

export interface ActionOp<T extends ManagerActionType> {
  type: T;
  category: ManagerActionCategory;
  risk: ManagerActionRisk;
  /** No policy may ever approve it without the user (spec § 4.3). */
  pinnedAsk: boolean;
  scope: 'project' | 'workspace' | 'manager';
  summary: string;
  usage: string;
  /** The connected project it acts in; scope and access are checked against it. */
  project(action: ActionOf<T>): string | undefined;
  /** Also read at the decision: a grant revoked while the card waited fails it. */
  refusal(manager: Manager, action: ActionOf<T>): string | undefined;
  /** Refusals that need the engine (runner, grants), checked only at proposal. */
  precheck?(ctx: ActionContext, manager: Manager, action: ActionOf<T>): Promise<ActionRefusal | undefined>;
  /** The facts the card shows, read by the server: what the user decides on is never the agent's word. */
  stamp(ctx: ActionContext, action: ActionOf<T>): Promise<ActionOf<T> | ActionRefusal>;
  /** A repeat with an equal key answers the waiting card instead of adding one. */
  key(action: ActionOf<T>): string;
  /** What one waiting card may exist for; a newer proposal replaces the older card. Absent: kinds may repeat. */
  subject(action: ActionOf<T>): string | undefined;
  /** The replaced card's closing line. */
  replacedBy(action: ActionOf<T>): string;
  /** "Merge of p#12": the note, the alert and the change log's summary. */
  describe(action: ActionOf<T>): string;
  perform(ctx: ActionContext, action: ActionOf<T>): Promise<ActionOutcome>;
  /** Why the card is moot now, or `undefined` while it is current or unknown. */
  stale?(ctx: ActionContext, action: ActionOf<T>): Promise<string | undefined>;
  /**
   * Every cockpit released with managers can show this type, so an approve without `seen` is still
   * allowed (old phones keep working). Only the types that predate the pin set it: a new type must
   * not, so a cockpit too old to show it cannot approve it blind (spec 2026-11-20 § 2.2).
   */
  shownByEveryCockpit?: true;
}

const SUMMARY_LIMIT = 8_000;
/** Long on purpose: the end of a definition is its prompt, and a card must not hide that. */
const clipSummary = (text: string): string =>
  text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}… (cut, open the automation to read it all)` : text;

const projectRefusal = (verb: string) => (manager: Manager, action: { projectId: string }): string | undefined =>
  managerAccessOf(manager, action.projectId) === 'read'
    ? `${action.projectId} is read-only for this manager: it cannot ${verb} anything there.`
    : undefined;
const READ_ONLY_REFUSAL = projectRefusal('merge or enable');

const mergeOp: ActionOp<'merge-pr'> = {
  type: 'merge-pr',
  shownByEveryCockpit: true,
  category: 'pull-requests',
  risk: 'high',
  pinnedAsk: true,
  scope: 'project',
  summary: 'Merge a pull request (refused if it changed after the proposal)',
  usage: 'cez manager merge --project <id> <number> [--method merge|squash|rebase] [--reason <text>]',
  project: (action) => action.projectId,
  refusal: READ_ONLY_REFUSAL,
  async stamp(ctx, action) {
    const response = await ctx.forward(`/p/${encodeURIComponent(action.projectId)}/github/prs/${action.number}/merge-state`);
    if (!response.ok) return ctx.refusalOf(response);
    const body = (await response.json()) as { available: boolean; reason?: string; mergeState?: { title: string; state: string; headSha: string } };
    if (!body.available || !body.mergeState) return { error: body.reason ?? 'GitHub merge is unavailable', status: 409 };
    if (body.mergeState.state !== 'open') return { error: `#${action.number} is already ${body.mergeState.state}`, status: 409 };
    // The forge's title, never the agent's: the card is what the user decides on.
    return { ...action, title: body.mergeState.title.slice(0, 1000), headSha: body.mergeState.headSha };
  },
  // The stamped facts count: a stale card must not stand in for what changed since. The method too.
  key: (action) => `merge:${action.projectId}:${action.number}:${action.headSha}:${action.method ?? ''}`,
  subject: (action) => `merge:${action.projectId}:${action.number}`,
  replacedBy: (action) => `Replaced by a newer proposal${action.headSha ? ` for head ${action.headSha.slice(0, 12)}` : ''}${action.method ? ` (${action.method})` : ''}`,
  describe: (action) => `Merge of ${action.projectId}#${action.number}`,
  async perform(ctx, action) {
    const prefix = `/p/${encodeURIComponent(action.projectId)}`;
    const state = await ctx.forward(`${prefix}/github/prs/${action.number}/merge-state?refresh=1`);
    const body = (await state.json().catch(() => ({}))) as { available?: boolean; reason?: string; mergeState?: { state?: string; headSha: string; defaultMethod: 'merge' | 'squash' | 'rebase' | null; methods: Array<'merge' | 'squash' | 'rebase'> } };
    if (!body.available || !body.mergeState) return { ok: false, result: body.reason ?? 'GitHub merge is unavailable' };
    const prState = body.mergeState.state;
    if (prState === 'merged' || prState === 'closed') return { ok: false, dismissed: true, result: `#${action.number} was already ${prState}` };
    const method = action.method ?? body.mergeState.defaultMethod ?? body.mergeState.methods[0];
    if (!method) return { ok: false, result: 'This repository allows no merge method.' };
    // The head the user was shown: a push after the proposal refuses instead of merging unseen code.
    const merged = await ctx.forward(`${prefix}/github/prs/${action.number}/merge`, {
      method: 'POST',
      body: { method, expectedHeadSha: action.headSha ?? body.mergeState.headSha },
    });
    if (merged.ok) return { ok: true, result: `Merged #${action.number}` };
    return { ok: false, result: (await ctx.refusalOf(merged)).error };
  },
  async stale(ctx, action) {
    const state = await ctx.prState(action.projectId, action.number);
    return state ? `#${action.number} was already ${state}` : undefined;
  },
};

const automationPath = (action: { projectId: string; automationId: string }): string =>
  `/p/${encodeURIComponent(action.projectId)}/automations/${encodeURIComponent(action.automationId)}`;

const enableOp: ActionOp<'enable-automation'> = {
  type: 'enable-automation',
  shownByEveryCockpit: true,
  category: 'automations',
  risk: 'high',
  pinnedAsk: true,
  scope: 'project',
  summary: 'Enable a paused automation (refused if it was edited after the proposal)',
  usage: 'cez manager automation --project <id> enable <automation id> [--reason <text>]',
  project: (action) => action.projectId,
  refusal: READ_ONLY_REFUSAL,
  async stamp(ctx, action) {
    const response = await ctx.forward(automationPath(action));
    if (!response.ok) return ctx.refusalOf(response);
    const { automation } = (await response.json()) as { automation?: AutomationDefinition };
    if (!automation) return { error: 'automation not found', status: 404 };
    if (automation.enabled) return { error: 'that automation is already enabled', status: 409 };
    const { id: _id, revision: _revision, enabled: _enabled, createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = automation;
    return { ...action, name: automation.name.slice(0, 1000), revision: automation.revision, summary: clipSummary(JSON.stringify(definition)) };
  },
  key: (action) => `enable:${action.projectId}:${action.automationId}:${action.revision}`,
  subject: (action) => `enable:${action.projectId}:${action.automationId}`,
  replacedBy: (action) => `Replaced by a newer proposal (revision ${action.revision})`,
  describe: (action) => `Enabling automation ${action.name ?? action.automationId}`,
  async perform(ctx, action) {
    const current = await ctx.forward(automationPath(action));
    if (!current.ok) return { ok: false, result: (await ctx.refusalOf(current)).error };
    const { automation } = (await current.json()) as { automation?: { revision?: number } };
    if (automation?.revision !== action.revision) return { ok: false, result: 'This automation changed after the proposal. Ask for a new one.' };
    const response = await ctx.forward(`${automationPath(action)}/enable`, { method: 'POST' });
    if (response.ok) return { ok: true, result: `Enabled ${action.name ?? action.automationId}` };
    return { ok: false, result: (await ctx.refusalOf(response)).error };
  },
  async stale(ctx, action) {
    try {
      const response = await ctx.forward(automationPath(action));
      if (response.status === 404) return 'Automation was deleted since the proposal';
      if (!response.ok) return undefined;
      const { automation } = (await response.json()) as { automation?: { revision?: number; enabled?: boolean } };
      if (!automation) return undefined;
      if (automation.enabled) return 'Automation is already enabled';
      return automation.revision !== action.revision ? `Automation changed since the proposal (rev ${action.revision} -> ${automation.revision})` : undefined;
    } catch {
      return undefined;
    }
  },
};

/** A job runs unattended, so one the agent asks for waits for the user too. */
const jobOp: ActionOp<'add-job'> = {
  type: 'add-job',
  shownByEveryCockpit: true,
  category: 'jobs',
  risk: 'high',
  pinnedAsk: true,
  scope: 'manager',
  summary: 'Add a saved job: a prompt this manager runs on its own interval',
  usage: 'cez manager job add --name <name> --every <minutes, 5..10080> "<prompt>" [--reason <text>]',
  project: () => undefined,
  refusal: () => undefined,
  stamp: async (_ctx, action) => action,
  key: (action) => `job:${action.name}:${action.everyMinutes}:${action.prompt}`,
  subject: () => undefined,
  replacedBy: () => 'Replaced by a newer proposal',
  describe: (action) => `Adding job ${action.name}`,
  async perform(ctx, action) {
    // Counted from now: an approved job must not fire seconds after the click.
    const added = ctx.addJob({ name: action.name, prompt: action.prompt, everyMinutes: action.everyMinutes, enabled: true, lastRunAt: ctx.iso() });
    return 'error' in added ? { ok: false, result: added.error } : { ok: true, result: `Added job ${action.name}` };
  },
};

export const CONNECTORS_CLAUDE_ONLY = 'Only a Claude Code manager can use connectors: Codex, OpenCode and the others keep their own MCP configuration.';

const connectorOp: ActionOp<'connector-call'> = {
  type: 'connector-call',
  shownByEveryCockpit: true,
  category: 'connectors',
  risk: 'high',
  pinnedAsk: true,
  scope: 'manager',
  summary: 'Make one connector write call with exactly these arguments',
  usage: 'cez manager propose-action --connector <key> --tool <tool> --args \'<json>\' [--reason <text>]',
  project: () => undefined,
  refusal: (manager, action) => managerConnectorToolMode(manager.connectors?.[action.connector], action.tool) === 'deny'
    ? `${action.tool} on ${action.connectorName ?? action.connector} is not granted to this manager: the user can grant it in its settings under Connectors.`
    : undefined,
  async precheck(ctx, manager, action) {
    if (managerConnectorToolMode(manager.connectors?.[action.connector], action.tool) === 'allow') {
      return { error: `${connectorToolName(action.connector, action.tool)} is granted without asking: call it directly instead of proposing it`, status: 400 };
    }
    if ((await ctx.runner()) !== 'claude') return { error: CONNECTORS_CLAUDE_ONLY, status: 409 };
    return undefined;
  },
  // Claude's server name, never the agent's: the card is what the user decides on.
  stamp: async (ctx, action) => ({ ...action, connectorName: ctx.connectorName(action.connector).slice(0, 200) }),
  key: (action) => `connector:${action.connector}:${action.tool}:${canonicalJson(action.args)}`,
  subject: () => undefined,
  replacedBy: () => 'Replaced by a newer proposal',
  describe: (action) => `Calling ${action.tool} on ${action.connectorName ?? action.connector}`,
  perform: (ctx, action) => ctx.callConnector(action),
};

export const ACTION_OPS: { readonly [T in ManagerActionType]: ActionOp<T> } = {
  'merge-pr': mergeOp,
  'enable-automation': enableOp,
  'add-job': jobOp,
  'connector-call': connectorOp,
};

/** The op for any action, typed loosely so one call site serves every type. */
export const actionOp = (action: ManagerActionRequest): ActionOp<ManagerActionType> =>
  ACTION_OPS[action.type] as unknown as ActionOp<ManagerActionType>;

export const actionProject = (action: ManagerActionRequest): string | undefined => actionOp(action).project(action);
export const actionRefusal = (manager: Manager, action: ManagerActionRequest): string | undefined => actionOp(action).refusal(manager, action);
export const actionKey = (action: ManagerActionRequest): string => actionOp(action).key(action);
export const actionSubject = (action: ManagerActionRequest): string | undefined => actionOp(action).subject(action);
export const actionReplacedBy = (action: ManagerActionRequest): string => actionOp(action).replacedBy(action);
export const describeAction = (action: ManagerActionRequest): string => actionOp(action).describe(action);

/** What this manager may propose now, for `cez manager propose --help` and the `action-ops` route. */
export function actionOpsFor(manager: Manager, runner: string): ManagerActionOp[] {
  const anyWrite = manager.projects === 'all'
    ? manager.access !== 'read' || Object.values(manager.projectAccess ?? {}).some((access) => access === 'write')
    : manager.projects.some((projectId) => managerAccessOf(manager, projectId) === 'write');
  const grantedConnector = Object.values(manager.connectors ?? {}).some((grant) => grant.level === 'write' || Object.values(grant.tools ?? {}).some((mode) => mode === 'ask'));
  const unavailable = (op: ActionOp<ManagerActionType>): string | undefined => {
    if (op.scope === 'project' && !anyWrite) return 'every project is read-only for this manager';
    if (op.type === 'connector-call') {
      if (runner !== 'claude') return CONNECTORS_CLAUDE_ONLY;
      if (!grantedConnector) return 'no connector grants write calls to this manager: the user can grant one in its settings under Connectors';
    }
    return undefined;
  };
  return (Object.values(ACTION_OPS) as ActionOp<ManagerActionType>[]).map((op) => {
    const reason = unavailable(op);
    return {
      type: op.type,
      category: op.category,
      risk: op.risk,
      pinnedAsk: op.pinnedAsk,
      scope: op.scope,
      summary: op.summary,
      usage: op.usage,
      available: reason === undefined,
      ...(reason ? { reason } : {}),
    };
  });
}

/** The card's fingerprint: what the user is shown is what the approval acts on. */
export const actionPin = (action: ManagerActionRequest): string =>
  createHash('sha256').update(canonicalJson(action)).digest('hex').slice(0, 32);

export const CARD_CHANGED = 'This card changed since your device showed it. Reload and decide again.';
export const UPDATE_TO_APPROVE = 'Update cezar on this device to approve this: it cannot show what this card would do.';

/** Why an approve must not go through on what this device showed, or `undefined` (spec 2026-11-20 § 2.2). */
export function seenRefusal(op: Pick<ActionOp<ManagerActionType>, 'shownByEveryCockpit'>, pin: string | undefined, seen: string | undefined): ActionRefusal | undefined {
  // A card from before the pin: nothing to compare.
  if (pin === undefined) return undefined;
  if (seen !== undefined && seen !== pin) return { error: CARD_CHANGED, status: 409 };
  if (seen === undefined && !op.shownByEveryCockpit) return { error: UPDATE_TO_APPROVE, status: 409 };
  return undefined;
}
