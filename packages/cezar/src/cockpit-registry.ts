/**
 * Which cockpits are running on this machine: `cezarHomeDir()/cockpits/<pid>.json`.
 *
 * A cockpit writes its address when it starts listening and removes the file on exit; a reader
 * ignores (and sweeps) files whose pid is dead, so a crash leaves nothing that matters. State that is
 * written, never required (AGENTS.md § Zero config): with no file, every client behaves as before.
 *
 * Only `cezar mcp` and `cezar integrations print` read it — a person (or an agent host such as
 * Hermes/OpenClaw) who asked for a cockpit and named none. Never inside a task: for an agent a
 * missing `CEZ_API_URL` is a deliberate "this cockpit withheld the feature" signal
 * (`cockpit-address.ts`), so the discovery refuses when `CEZ_TASK_ID` is set. `cez task`,
 * `cez automation` and `cez runs` do not use it at all.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from './paths.ts';

const cockpitRecordSchema = z.object({
  url: z.string().url(),
  pid: z.number().int().positive(),
  repoRoot: z.string(),
  startedAt: z.string(),
});
export type CockpitRecord = z.infer<typeof cockpitRecordSchema>;

export function cockpitsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'cockpits');
}

/** Record this process as a running cockpit. Best effort; returns the removal (also run on exit). */
export function registerCockpit(
  info: { url: string; repoRoot: string },
  opts: { dir?: string; pid?: number; now?: () => Date } = {},
): () => void {
  const dir = opts.dir ?? cockpitsDir();
  const pid = opts.pid ?? process.pid;
  const file = join(dir, `${pid}.json`);
  const remove = () => {
    try {
      rmSync(file, { force: true });
    } catch {
      // nothing to clean
    }
  };
  try {
    assertCezarHomeWriteIsSandboxed(dir);
    mkdirSync(dir, { recursive: true });
    const record: CockpitRecord = { url: info.url, pid, repoRoot: info.repoRoot, startedAt: (opts.now?.() ?? new Date()).toISOString() };
    writeFileSync(file, JSON.stringify(record), 'utf8');
    process.once('exit', remove);
  } catch {
    // a read-only home must not fail the boot
  }
  return remove;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, we just may not signal it.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Live cockpits, newest first. Unreadable files are skipped; dead ones are swept. */
export function liveCockpits(opts: { dir?: string; alive?: (pid: number) => boolean } = {}): CockpitRecord[] {
  const dir = opts.dir ?? cockpitsDir();
  const alive = opts.alive ?? pidAlive;
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const found: CockpitRecord[] = [];
  for (const name of names) {
    try {
      const parsed = cockpitRecordSchema.safeParse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      if (!parsed.success) continue;
      if (alive(parsed.data.pid)) found.push(parsed.data);
      else rmSync(join(dir, name), { force: true });
    } catch {
      // half-written or foreign file
    }
  }
  return found.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

const norm = (path: string) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));

function contains(root: string, cwd: string): boolean {
  const base = norm(root);
  const at = norm(cwd);
  return at === base || at.startsWith(base.endsWith(sep) ? base : base + sep);
}

export interface CockpitPick {
  record: CockpitRecord;
  /** One line for stderr / a snippet comment: why this one. */
  reason: string;
}

/** One cockpit: it. Several: the one serving `cwd` (deepest root), else the newest — and say so. */
export function pickCockpit(records: readonly CockpitRecord[], cwd: string): CockpitPick | undefined {
  if (records.length === 0) return undefined;
  if (records.length === 1) return { record: records[0]!, reason: `the only running cockpit (pid ${records[0]!.pid})` };
  const matching = records.filter((record) => contains(record.repoRoot, cwd)).sort((a, b) => b.repoRoot.length - a.repoRoot.length);
  if (matching[0]) return { record: matching[0], reason: `${records.length} cockpits running; chose the one serving ${matching[0].repoRoot} (pid ${matching[0].pid})` };
  const newest = records[0]!;
  return { record: newest, reason: `${records.length} cockpits running, none serving ${cwd}; chose the most recent (pid ${newest.pid}, ${newest.repoRoot})` };
}

/** What `cezar mcp` / `integrations print` call: `undefined` inside a task or when nothing runs. */
export function discoverCockpit(
  env: { CEZ_TASK_ID?: string },
  cwd: string = process.cwd(),
  opts: { dir?: string; alive?: (pid: number) => boolean } = {},
): CockpitPick | undefined {
  if (env.CEZ_TASK_ID) return undefined;
  return pickCockpit(liveCockpits(opts), cwd);
}
