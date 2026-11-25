import {
  registerProjectInputSchema,
  registerProjectResponseSchema,
} from '@open-mercato/cezar-contract';
import type { CockpitRuntimeRecord } from './cockpit-runtime.ts';

/** Machine-readable twin of the "cockpit →" line: the desktop shell parses it when its sidecar
 *  hands off to an already-running cockpit and exits 0 (telemetry f3893dd3). Keep it stable. */
export const HANDOFF_MARKER = 'cezar-handoff:';
export const handoffMarkerLine = (url: string): string => `${HANDOFF_MARKER} ${url}`;

export interface CockpitHandoffResult {
  projectId: string;
  projectName: string;
  added: boolean;
  url: string;
}

export async function handoffProject(
  runtime: CockpitRuntimeRecord,
  root: string,
  opts: {
    fetcher?: typeof fetch;
    open?: (url: string) => void;
    openBrowser?: boolean;
    log?: (message: string) => void;
    timeoutMs?: number;
  } = {},
): Promise<CockpitHandoffResult> {
  const input = registerProjectInputSchema.parse({ root });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5_000);
  try {
    const response = await (opts.fetcher ?? fetch)(`${runtime.origin}/api/v1/projects`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-cezar-runtime-handoff': runtime.owner.token,
      },
      body: JSON.stringify(input),
    });
    const parsed = registerProjectResponseSchema.safeParse(await response.json().catch(() => null));
    if ((response.status !== 200 && response.status !== 409) || !parsed.success) {
      throw new Error(`running cockpit refused project registration (HTTP ${response.status})`);
    }
    const project = parsed.data.project;
    const added = response.status === 200;
    const url = `${runtime.origin.replace(/\/+$/, '')}/p/${encodeURIComponent(project.id)}/`;
    (opts.log ?? console.log)(
      `  cockpit already running (pid ${runtime.owner.pid}) — ${added ? 'added' : 'opened'} ${project.name}`,
    );
    (opts.log ?? console.log)(`  cockpit → ${url}`);
    (opts.log ?? console.log)(handoffMarkerLine(url));
    if (opts.openBrowser !== false) opts.open?.(url);
    return { projectId: project.id, projectName: project.name, added, url };
  } finally {
    clearTimeout(timer);
  }
}
