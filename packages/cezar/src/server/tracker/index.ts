import type {
  TrackerKind, TrackerAssociationInput, TrackerAssociationResult, TrackerCandidatesQuery,
  TrackerCandidatesResult, TrackerFailure, TrackerCredentials, TrackerConnectionResponse, TrackerListQuery, TrackerSearchQuery, TrackerItemsResult,
} from '@open-mercato/cezar-contract';
import { readTrackerAssociation } from '../../tracker-association.ts';
import { createDryTrackerClient } from './dry-run.ts';
import { createJiraClient } from './jira.ts';
import { createLinearClient } from './linear.ts';
import { TrackerConnections } from './connections.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { requestFailure, TrackerRequestError } from './transport.ts';
import type { TrackerProvider, TrackerDriver } from './types.ts';

const missing = (): TrackerFailure => ({
  available: false, code: 'credentials_missing',
  reason: 'Configure a connection for this project in Settings → Issue tracker. Server-wide credentials are not used.',
});
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
    const { record, error } = demo ? { record: null } : await store.inspect(root);
    return { connection: record ? { id: record.id, kind: record.credentials.kind } : null, demo, ...(error ? { error } : {}) };
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
    async saveConnection(root: string, credentials: TrackerCredentials): Promise<TrackerConnectionResponse | null> {
      if (demo) return null;
      const saved = await store.write(root, credentials);
      if (!saved) return null;
      invalidate(root);
      return { connection: { id: saved.id, kind: saved.credentials.kind }, demo: false };
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
