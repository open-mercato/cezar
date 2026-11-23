import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  MANAGER_MEMORY_LIMITS,
  managerMemoryEntrySchema,
  managerMemoryKeySchema,
  type ManagerMemoryEntry,
  type ManagerMemoryKind,
  type PutManagerMemoryInput,
} from '@open-mercato/cezar-contract';
import { atomicWriteJsonSync } from '../workspace/config.ts';

/**
 * A manager's memory, owned by cezar and the same on every runner (spec
 * 2026-11-21-manager-short-sessions-and-memory § 2.1): what the user wants remembered, carried
 * into every new session's system prompt. `~/.cezar/managers/<id>/memory.json`.
 */

const fileSchema = z
  .object({
    entries: z.array(z.unknown()).catch([]),
    /** The one-time import of Claude Code's own auto-memory for this manager's workdir. */
    imported: z.object({ at: z.string(), count: z.number().int().min(0) }).optional().catch(undefined),
  })
  .passthrough();

export interface MemoryFile {
  entries: ManagerMemoryEntry[];
  imported?: { at: string; count: number };
}

export const memoryPath = (dir: string): string => join(dir, 'memory.json');

/** Undefined when the manager has no memory file yet (it has not been imported or written). */
export function readMemory(dir: string, warn: (message: string) => void = () => {}): MemoryFile | undefined {
  const path = memoryPath(dir);
  if (!existsSync(path)) return undefined;
  try {
    const raw = fileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    // One bad entry never costs the others.
    const entries = raw.entries.flatMap((entry) => {
      const parsed = managerMemoryEntrySchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
    return { entries, ...(raw.imported ? { imported: raw.imported } : {}) };
  } catch (error) {
    warn(`manager memory ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return { entries: [] };
  }
}

export function writeMemory(dir: string, file: MemoryFile): void {
  atomicWriteJsonSync(memoryPath(dir), file);
}

const entryLine = (entry: ManagerMemoryEntry): string =>
  `- ${entry.text}${entry.why ? ` (why: ${entry.why})` : ''} [${entry.kind}: ${entry.key}]`;

/** The system prompt's block; empty when there is nothing to remember. */
export function renderMemory(entries: ManagerMemoryEntry[]): string {
  if (entries.length === 0) return '';
  return `What the user asked you to remember (your memory; keep it current with \`cez-manager memory\`):\n${entries.map(entryLine).join('\n')}`;
}

export const memoryBytes = (entries: ManagerMemoryEntry[]): number => Buffer.byteLength(renderMemory(entries), 'utf8');

const normalized = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export type MemoryRefusal = { error: string; status: 400 | 404 | 409 };

/** Same key replaces; a near-duplicate under another key or a write over budget is refused. */
export function setMemoryEntry(
  file: MemoryFile,
  key: string,
  input: Omit<PutManagerMemoryInput, 'source'>,
  at: string,
  source: ManagerMemoryEntry['source'],
): MemoryFile | MemoryRefusal {
  const entry: ManagerMemoryEntry = {
    key,
    kind: input.kind,
    text: input.text.trim(),
    ...(input.why?.trim() ? { why: input.why.trim() } : {}),
    updatedAt: at,
    source,
  };
  const duplicate = file.entries.find((other) => other.key !== key && normalized(other.text) === normalized(entry.text));
  if (duplicate) return { error: `memory "${duplicate.key}" already says this: replace that key instead`, status: 409 };
  const others = file.entries.filter((other) => other.key !== key);
  const exists = others.length !== file.entries.length;
  const entries = exists ? file.entries.map((other) => (other.key === key ? entry : other)) : [...others, entry];
  if (entries.length > MANAGER_MEMORY_LIMITS.entries || memoryBytes(entries) > MANAGER_MEMORY_LIMITS.bytes) {
    const oldest = [...others].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, 5).map((other) => other.key);
    return {
      error: `memory is full (${MANAGER_MEMORY_LIMITS.entries} entries, ${MANAGER_MEMORY_LIMITS.bytes} bytes): replace or remove one first; oldest: ${oldest.join(', ')}`,
      status: 409,
    };
  }
  return { ...file, entries };
}

export function removeMemoryEntry(file: MemoryFile, key: string): MemoryFile | MemoryRefusal {
  if (!file.entries.some((entry) => entry.key === key)) return { error: `no memory "${key}"`, status: 404 };
  return { ...file, entries: file.entries.filter((entry) => entry.key !== key) };
}

// ---- the one-time import of Claude Code's auto-memory ---------------------------------------

/** Claude's project directory name for a cwd: every non-alphanumeric character becomes `-`. */
const claudeSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

const KIND_OF: Record<string, ManagerMemoryKind> = { feedback: 'feedback', user: 'preference', project: 'pointer', reference: 'pointer' };

function frontmatter(source: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) return { fields: {}, body: source };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^\s*([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (field && field[2]) fields[field[1]!] = field[2].replace(/^["']|["']$/g, '').trim();
  }
  return { fields, body: match[2]! };
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

const keyOf = (name: string): string | undefined => {
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
  return managerMemoryKeySchema.safeParse(key).success ? key : undefined;
};

/**
 * Claude Code's auto-memory for the manager's workdir (`<config>/projects/<slug>/memory/*.md`, one
 * fact per file with `name`/`description`/`type` frontmatter), as entries within the budget.
 */
export function claudeAutoMemory(workdir: string, configDir: string | undefined, at: string): ManagerMemoryEntry[] {
  const root = join(configDir || join(homedir(), '.claude'), 'projects');
  const dirs = [workdir];
  try {
    const real = realpathSync(workdir);
    if (real !== workdir) dirs.push(real);
  } catch {
    // a missing workdir: nothing to import from its real path
  }
  for (const dir of dirs) {
    const memoryDir = join(root, claudeSlug(dir), 'memory');
    let names: string[];
    try {
      names = readdirSync(memoryDir).filter((name) => name.endsWith('.md') && name !== 'MEMORY.md').sort();
    } catch {
      continue;
    }
    const entries: ManagerMemoryEntry[] = [];
    for (const name of names) {
      let source: string;
      try {
        source = readFileSync(join(memoryDir, name), 'utf8');
      } catch {
        continue;
      }
      const { fields, body } = frontmatter(source);
      const key = keyOf(fields.name ?? name.replace(/\.md$/, ''));
      const text = (fields.description ?? body.split(/\r?\n/).find((line) => line.trim())) ?? '';
      if (!key || !text.trim() || entries.some((entry) => entry.key === key)) continue;
      const why = /\*\*Why:\*\*\s*(.+)/.exec(body)?.[1]?.trim();
      const entry: ManagerMemoryEntry = {
        key,
        kind: KIND_OF[fields.type ?? ''] ?? 'preference',
        text: clip(text.trim(), MANAGER_MEMORY_LIMITS.text),
        ...(why ? { why: clip(why, MANAGER_MEMORY_LIMITS.why) } : {}),
        updatedAt: at,
        source: 'import',
      };
      if (entries.length + 1 > MANAGER_MEMORY_LIMITS.entries || memoryBytes([...entries, entry]) > MANAGER_MEMORY_LIMITS.bytes) break;
      entries.push(entry);
    }
    return entries;
  }
  return [];
}
