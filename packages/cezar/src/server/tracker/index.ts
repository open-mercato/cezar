import type {
  TrackerKind, TrackerAssociationInput, TrackerAssociationResult, TrackerCandidatesQuery,
  TrackerCandidatesResult, TrackerFailure, TrackerConnectionInput, TrackerConnectionResponse, TrackerListQuery, TrackerSearchQuery, TrackerItemsResult,
  TrackerSharedConnectionsResponse,
} from '@open-mercato/cezar-contract';
import { readTrackerAssociation } from '../../tracker-association.ts';
import { createDryTrackerClient } from './dry-run.ts';
import { createJiraClient } from './jira.ts';
import { createLinearClient } from './linear.ts';
import { TrackerConnections, type ConnectionInspection, type ConnectionOutcome, type SharedConnectionSummary } from './connections.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { requestFailure, TrackerRequestError } from './transport.ts';
import type { TrackerProvider, TrackerDriver } from './types.ts';

const missing = (): TrackerFailure => ({
  available: false, code: 'credentials_missing',
  reason: 'Configure a connection for this project in Settings → Issue tracker. Server-wide credentials are not used.',
});
/** Per provider, so a new tracker must name what identifies its shared connection (no secrets). */
const sharedLabels: Record<TrackerKind, (item: SharedConnectionSummary) => string> = {
  jira: item => {
    const host = item.credentials.origin ? new URL(item.credentials.origin).host : 'Jira';
    const [local = '', domain = ''] = (item.credentials.email ?? '').split('@');
    return `${domain ? `${host} — ${local.slice(0, 1)}…@${domain}` : host} · ${item.id.slice(0, 4)}`;
  },
  linear: item => `Linear API key · saved ${item.createdAt.slice(0, 10)} · ${item.id.slice(0, 4)}`,
};
const changed = (): TrackerFailure => ({ available: false, code: 'source_changed', reason: 'This project connection changed. Reconnect the tracker scope in Settings.' });

/** Secrets, adapter instances and cursor namespaces belong to a project and connection revision. */
export function createTrackerService(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch) {
  const store = new TrackerConnections(env);
  const demo = env.CEZ_DRY_RUN === '1';
  const providers = new Map<string, { root: string; provider: TrackerProvider }>();
  const invalidate = (root: string) => {
    for (const [key, entry] of providers) if (entry.root === root) {
      entry.provider.clearCache(); providers.delete(key);
    }
  };
  const connection = async (root: string): Promise<TrackerConnectionResponse> => {
    const { record, error, shared }: ConnectionInspection = demo ? { record: null } : await store.inspect(root);
    return {
      connection: record ? { id: record.id, kind: record.credentials.kind, ...(shared ? { shared } : {}) } : null,
      demo, ...(error ? { error } : {}),
    };
  };
  const settle = (root: string, outcome: ConnectionOutcome, shared: boolean): TrackerConnectionResponse | { saveFailure: string | null } => {
    if (!('record' in outcome)) return { saveFailure: outcome.error };
    invalidate(root);
    return { connection: { id: outcome.record.id, kind: outcome.record.credentials.kind, ...(shared ? { shared: true as const } : {}) }, demo: false };
  };
  const get = async (root: string, kind: TrackerKind) => {
    const record = demo ? null : await store.read(root);
    if (!demo && (!record || record.credentials.kind !== kind)) { invalidate(root); return null; }
    const id = demo ? 'demo' : record!.id;
    const key = JSON.stringify([root, id, kind]);
    let entry = providers.get(key);
    if (!entry) {
      // Drop old credentials and caches after replacement, including writes by another process.
      if (!demo) invalidate(root);
      const factories: Record<TrackerKind, () => TrackerProvider> = {
        jira: () => {
          if (record?.credentials.kind !== 'jira') throw new Error('Invalid connection');
          const { origin, email, token } = record.credentials;
          return createJiraClient({ origin: new URL(origin).origin, email, token }, fetcher);
        },
        linear: () => {
          if (record?.credentials.kind !== 'linear') throw new Error('Invalid connection');
          return createLinearClient({ key: record.credentials.key }, fetcher);
        },
      };
      entry = { root, provider: demo ? createDryTrackerClient(kind) : factories[kind]() };
      if (providers.size >= 100) {
        const first = providers.keys().next().value!;
        providers.get(first)?.provider.clearCache(); providers.delete(first);
      }
      providers.set(key, entry);
    }
    const current = async () => demo || (await store.read(root))?.id === id;
    return { provider: entry.provider, id, current };
  };
  return {
    connection,
    /** `{ saveFailure }` carries a user-facing reason, or `null` for the generic storage failure. */
    async saveConnection(root: string, input: TrackerConnectionInput): Promise<TrackerConnectionResponse | { saveFailure: string | null }> {
      if (demo) return { saveFailure: null };
      const { shared, ...credentials } = input;
      return settle(root, await store.saveCredentials(root, credentials, { shared: shared === true }), shared === true);
    },
    /** Spec 2026-11-18-shared-tracker-connections: the explicit pick that lets a project use one. */
    async linkSharedConnection(root: string, sharedId: string): Promise<TrackerConnectionResponse | { saveFailure: string | null } | { missing: true }> {
      if (demo) return { saveFailure: null };
      const outcome = await store.link(root, sharedId);
      return 'missing' in outcome ? outcome : settle(root, outcome, true);
    },
    async promoteConnection(root: string): Promise<TrackerConnectionResponse | { saveFailure: string | null }> {
      if (demo) return { saveFailure: null };
      return settle(root, await store.promote(root), true);
    },
    async sharedConnections(root: string): Promise<TrackerSharedConnectionsResponse> {
      if (demo) return { connections: [], demo };
      const [listed, current] = await Promise.all([store.listShared(), store.inspect(root)]);
      return {
        connections: listed.map(item => ({
          id: item.id, kind: item.kind, createdAt: item.createdAt, current: current.sharedId === item.id,
          label: sharedLabels[item.kind](item),
        })),
        demo,
      };
    },
    async removeConnection(root: string): Promise<boolean> {
      if (demo) return false;
      const removed = await store.remove(root);
      if (removed) invalidate(root);
      return removed;
    },
    async candidates(root: string, query: TrackerCandidatesQuery): Promise<TrackerCandidatesResult> {
      const handle = await get(root, query.kind);
      if (!handle) { const status = await connection(root); return status.error ? { available: false, code: 'unavailable', reason: status.error } : missing(); }
      try {
        const scope = [root, handle.id, query.kind, 'candidates'];
        const result = await handle.provider.listCandidates({ ...query, cursor: decodeCursor(scope, query.cursor) });
        if (!await handle.current()) return changed();
        return result.available && result.nextCursor
          ? { ...result, nextCursor: encodeCursor(scope, result.nextCursor) } : result;
      } catch (error) {
        const failure = requestFailure(error);
        return failure.code === 'not_found' ? { ...failure, code: 'unavailable' } : failure;
      }
    },
    async resolve(root: string, input: TrackerAssociationInput): Promise<TrackerAssociationResult> {
      const handle = await get(root, input.kind);
      if (!handle) { const status = await connection(root); return status.error ? { available: false, code: 'unavailable', reason: status.error } : missing(); }
      if (!demo && input.connectionId !== handle.id) return changed();
      const result = await handle.provider.resolveAssociation(input);
      if (!await handle.current()) return changed();
      return result.available && !demo
        ? { ...result, association: { ...result.association, connectionId: handle.id } } : result;
    },
    async driver(root: string, dataDir: string): Promise<TrackerDriver | TrackerFailure> {
      const association = await readTrackerAssociation(dataDir);
      if (!association) return { available: false, code: 'not_configured', reason: 'Connect a tracker in project Settings.' };
      const handle = await get(root, association.kind);
      if (!handle) { const status = await connection(root); return status.error ? { available: false, code: 'unavailable', reason: status.error } : missing(); }
      if (!demo && association.connectionId !== handle.id) return changed();
      const driver = handle.provider.driver(association);
      const current = async () => await handle.current() && JSON.stringify(await readTrackerAssociation(dataDir)) === JSON.stringify(association);
      const read = async (query: TrackerListQuery | TrackerSearchQuery): Promise<TrackerItemsResult> => {
        if (!await current()) return changed();
        const operation = 'q' in query ? 'searchItems' : 'listIssues';
        try {
          const scope = [root, handle.id, association.kind, association.source.id, association.externalId, operation];
          const input = { ...query, cursor: decodeCursor(scope, query.cursor) };
          const result = operation === 'searchItems' && 'q' in input
            ? await driver.searchItems(input) : await driver.listIssues(input);
          if (!await current()) return changed();
          return result.available && result.nextCursor
            ? { ...result, nextCursor: encodeCursor(scope, result.nextCursor) } : result;
        } catch (error) {
          const failure = requestFailure(error);
          return failure.code === 'not_found' ? { ...failure, code: 'unavailable' } : failure;
        }
      };
      const assertCurrent = async () => {
        if (!await current()) {
          throw new TrackerRequestError('source_changed', 'This tracker connection or scope changed. Reconnect in Settings.');
        }
      };
      return {
        association, listIssues: read, searchItems: read,
        ...(driver.context ? { context: async (id: string) => {
          await assertCurrent();
          const result = await driver.context!(id);
          await assertCurrent();
          return result;
        } } : {}),
        ...(driver.act ? { act: async (id: string, action: Parameters<NonNullable<TrackerDriver['act']>>[1], beforeWrite?: () => Promise<void>) => {
          await assertCurrent();
          await driver.act!(id, action, async () => { await assertCurrent(); await beforeWrite?.(); });
          // An in-flight write cannot be rolled back. A changed binding leaves outcome unknown.
          await assertCurrent();
        } } : {}),
        ...(driver.automationOptions ? { automationOptions: async (query?: { search?: string; cursor?: string }) => {
          await assertCurrent();
          const result = await driver.automationOptions!(query);
          await assertCurrent();
          return result;
        } } : {}),
        ...(driver.pollEvents ? { pollEvents: async (input: Parameters<NonNullable<TrackerDriver['pollEvents']>>[0]) => {
          await assertCurrent();
          const result = await driver.pollEvents!(input);
          await assertCurrent();
          return result;
        } } : {}),
        async getItem(id) {
          if (!await current()) return changed();
          const result = await driver.getItem(id);
          return await current() ? result : changed();
        },
      };
    },
    clearCache: invalidate,
  };
}
