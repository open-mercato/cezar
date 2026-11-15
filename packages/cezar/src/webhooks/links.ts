import type { ServerState } from '../server-install/types.ts';
/** Only local installer records paired with this service identity can supply a public URL. */
export function hostedTaskLink(records: readonly { state: ServerState }[], mode: 'local' | 'hosted', port: number | undefined, instanceId: string | undefined, projectId: string, taskId: string): string | undefined {
  if (mode !== 'hosted' || !port || !instanceId || projectId === 'default') return;
  const matches = records.filter(({ state }) => state.installed && !state.dryRun && state.primaryPort === port && state.instanceId === instanceId && ['ubuntu-vps', 'macosx-ngrok'].includes(state.platform ?? ''));
  if (matches.length !== 1) return;
  try {
    const url = new URL(matches[0]!.state.publicUrl ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return;
    url.pathname = `/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;
    return url.href;
  } catch { return; }
}

import type { TrackerAssociation } from '@open-mercato/cezar-contract';
export function canonicalTrackerLink(tracker: { association?: TrackerAssociation; provider: 'jira' | 'linear'; key: string; url: string } | undefined, connected: TrackerAssociation | null): string | undefined {
  const captured = tracker?.association;
  if (!tracker || !captured || !connected || !connected.connectionId || tracker.provider !== connected.kind ||
    captured.kind !== connected.kind || captured.connectionId !== connected.connectionId || captured.externalId !== connected.externalId ||
    captured.source.id !== connected.source.id || captured.source.webUrl !== connected.source.webUrl || !/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(tracker.key)) return;
  try {
    const origin = new URL(connected.source.webUrl), supplied = new URL(tracker.url);
    if (origin.protocol !== 'https:' || supplied.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || supplied.username || supplied.password || supplied.origin !== origin.origin) return;
    const path = connected.kind === 'jira' ? `/browse/${tracker.key}` : `${origin.pathname.replace(/\/$/, '')}/issue/${tracker.key}`;
    if (connected.kind === 'jira' ? supplied.pathname !== path : supplied.pathname !== path && !supplied.pathname.startsWith(`${path}/`)) return;
    if (connected.kind === 'linear' && origin.hostname !== 'linear.app') return;
    return `${origin.origin}${path}`;
  } catch { return; }
}
