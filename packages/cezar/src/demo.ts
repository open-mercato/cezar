/**
 * Store-review demo (branch `demo/store-review`, never merged; spec 2026-11-20-store-review-demo).
 * `CEZ_DEMO=1` counts only with `CEZ_DRY_RUN=1`: agents are the bundled mock, nothing is real.
 */
export const demoMode = (env: NodeJS.ProcessEnv = process.env): boolean => env.CEZ_DRY_RUN === '1' && env.CEZ_DEMO === '1';

export const DEMO_REFUSAL = 'Not available in the demo.';

const RUN = '/runs/[^/]+';
const MANAGER = '/workspace/managers/[^/]+';
/** What a phone may change on the demo, as `METHOD path` with the `/api/v1[/p/<id>]` prefix stripped. */
const ALLOWED: RegExp[] = [
  'PUT /workspace/ui-state',
  'PUT /ui-state',
  'POST /runs',
  'POST /runs/read-all',
  'POST /runs/archive-finished',
  `PATCH ${RUN}`,
  `POST ${RUN}/(archive|pin|read|unread|cancel|start-now|messages|finish|continue|pr)`,
  `(PATCH|DELETE) ${RUN}/queued-messages/[^/]+`,
  `DELETE ${RUN}/drafts/[^/]+`,
  'POST /workspace/attention/overrides(/clear)?',
  'POST /workspace/questions/[^/]+/(answer|dismiss)',
  'POST /workspace/managers/activity',
  `POST ${MANAGER}/(messages|stop|read|check)`,
  `POST ${MANAGER}/actions/[^/]+/decision`,
  '(PUT|DELETE) /workspace/phone/push',
  'PUT /workspace/phone/push/prefs',
  // The cockpit's own pings; CEZ_TELEMETRY=0 drops them on the server.
  'POST /telemetry/(event|page)',
].map((rule) => new RegExp(`^${rule}$`));

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** True when a phone's request may reach its route. Reads always may; writes only through the list. */
export function demoAllows(method: string, pathname: string): boolean {
  if (!MUTATING.has(method)) return true;
  const path = pathname.replace(/^\/api\/v1/, '').replace(/^\/p\/[^/]+/, '').replace(/\/+$/, '');
  return ALLOWED.some((rule) => rule.test(`${method} ${path}`));
}
