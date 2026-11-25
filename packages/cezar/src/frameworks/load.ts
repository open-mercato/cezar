import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { frameworkFileSchema, type FrameworkFile, type FrameworkSource } from '@open-mercato/cezar-contract';
import { graphIssues } from '../workflows/graph.ts';
import { BUILTIN_FRAMEWORK_YAML } from './builtins.ts';
import { compileFramework } from './compile.ts';

/** Project frameworks: `.ai/cezar/frameworks/<id>.yaml`, committable (D15). */
export const FRAMEWORKS_SUBDIR = 'frameworks';

export interface LoadedFramework {
  id: string;
  source: FrameworkSource;
  yaml: string;
  /** `frameworkHash(yaml)` — what a card records as `frameworkHash` (D3). */
  hash: string;
  /** Project files only: absolute path. */
  path?: string;
  /** Absent exactly when `error` is set. */
  framework?: FrameworkFile;
  error?: string;
}

export function frameworkHash(yamlText: string): string {
  return createHash('sha256').update(yamlText).digest('hex').slice(0, 16);
}

/** Parse + validate one framework's YAML, including that it compiles to a sound graph. */
export function parseFrameworkYaml(yamlText: string): { framework: FrameworkFile } | { error: string } {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (err) {
    return { error: `not valid YAML: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = frameworkFileSchema.safeParse(doc);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ') };
  }
  const problems = graphIssues(compileFramework(parsed.data, { title: 'Example card', brief: '', fields: {} }), { frameworkNodes: true });
  if (problems.length) return { error: `compiles to an invalid workflow: ${problems.join('; ')}` };
  return { framework: parsed.data };
}

let builtinCache: LoadedFramework[] | undefined;

/** The built-ins never change at runtime, so they parse once; callers get copies. */
function builtins(): LoadedFramework[] {
  builtinCache ??= BUILTIN_FRAMEWORK_YAML.map(({ id, yaml }) => {
    const parsed = parseFrameworkYaml(yaml);
    return { id, source: 'builtin' as const, yaml, hash: frameworkHash(yaml), ...parsed };
  });
  return builtinCache.map((f) => ({ ...f }));
}

/**
 * Built-ins, then every `<dataDir>/frameworks/*.{yaml,yml}`. An invalid project file is listed
 * with `error`, never thrown; a project file may not reuse a built-in id or disagree with its
 * file name (the duplicate route addresses files by id).
 */
export async function listFrameworks(repoRoot: string, dataDir: string): Promise<LoadedFramework[]> {
  const list = builtins();
  const dir = join(dataDir, 'frameworks');
  let entries: string[] = [];
  try {
    entries = (await readdir(dir)).sort();
  } catch {
    return list;
  }
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (ext !== '.yaml' && ext !== '.yml') continue;
    const path = join(dir, entry);
    const id = entry.slice(0, -ext.length);
    let yaml: string;
    try {
      yaml = await readFile(path, 'utf8');
    } catch (err) {
      list.push({ id, source: 'project', yaml: '', hash: '', path, error: `cannot read ${relative(repoRoot, path)}: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const base = { id, source: 'project' as const, yaml, hash: frameworkHash(yaml), path };
    if (list.some((f) => f.id === id)) {
      list.push({ ...base, error: `"${id}" is already taken by another framework` });
      continue;
    }
    const parsed = parseFrameworkYaml(yaml);
    if ('framework' in parsed && parsed.framework.id !== id) {
      list.push({ ...base, error: `the file declares id "${parsed.framework.id}" but is named ${entry}` });
      continue;
    }
    list.push({ ...base, ...parsed });
  }
  return list;
}

export async function getFramework(repoRoot: string, dataDir: string, id: string): Promise<LoadedFramework | undefined> {
  return (await listFrameworks(repoRoot, dataDir)).find((f) => f.id === id);
}

/** Built-ins only — synchronous, in detection order. */
export function listBuiltinFrameworks(): LoadedFramework[] {
  return builtins();
}
