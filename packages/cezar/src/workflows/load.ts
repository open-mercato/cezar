import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  QUICK_TASK_WORKFLOW,
  normalizeWorkflowDoc,
  stepsIssue,
  workflowDefSchema,
  workflowFileSchema,
  type WorkflowDef,
} from './types.ts';

export const WORKFLOWS_DIR = '.ai/cezar/workflows';

export interface WorkflowLoadIssue {
  path: string;
  message: string;
}

/**
 * Load the workflow catalog: the built-in `quick-task` plus every
 * `.ai/cezar/workflows/*.{yaml,yml}` in the repo. File workflows win name
 * collisions with built-ins. Invalid files are reported, never fatal.
 */
export async function loadWorkflows(
  repoRoot: string,
): Promise<{ workflows: WorkflowDef[]; issues: WorkflowLoadIssue[] }> {
  const dir = resolve(repoRoot, WORKFLOWS_DIR);
  const issues: WorkflowLoadIssue[] = [];
  const fromFiles: WorkflowDef[] = [];

  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    // no workflows dir — built-ins only
  }

  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (ext !== '.yaml' && ext !== '.yml') continue;
    const path = join(dir, entry);
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = workflowFileSchema.safeParse(parseYaml(raw));
      if (!parsed.success) {
        issues.push({ path, message: parsed.error.issues.map((i) => i.message).join('; ') });
        continue;
      }
      // `skills:` shorthand files become plain agent steps here (spec 012).
      const normalized = normalizeWorkflowDoc(parsed.data);
      // Steps referenced by onFail.retry must exist and come earlier; ids unique.
      const issue = stepsIssue(normalized.steps);
      if (issue) {
        issues.push({ path, message: issue });
        continue;
      }
      fromFiles.push({ ...normalized, source: 'file', path });
    } catch (err) {
      issues.push({ path, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const fileNames = new Set(fromFiles.map((w) => w.name));
  const workflows = [
    ...fromFiles,
    ...[QUICK_TASK_WORKFLOW].filter((w) => !fileNames.has(w.name)),
  ];
  workflows.sort((a, b) => a.name.localeCompare(b.name));
  return { workflows, issues };
}

/**
 * The catalog's CURRENT entry under a queued run's snapshot name, when it differs from the
 * snapshot (#1078) — the definition that run should start with instead.
 *
 * `startRun` snapshots the workflow at creation (the record's `workflowDef`, #367), so a run that
 * waited in the queue while its file gained a step would otherwise run the old chain — while a
 * run started at that same instant gets the new one, because the loader has no cache. Only a
 * catalog entry is re-resolved: a workflow file, or the built-in `quick-task`. The ad-hoc chains
 * ("(planned)", "(inbox)") are `built-in` too but live on the record alone, so a file that
 * happens to share their name must never replace them. A file deleted or made invalid since the
 * run was queued is absent from the catalog, and the snapshot runs as before. That includes a file
 * that overrode `quick-task`: the loader then restores the built-in under the same name, so a
 * snapshot never moves from a file to a built-in — the file's steps would be silently dropped.
 *
 * Returns `undefined` when there is nothing newer to take. Compared through the persisted
 * schema, so a snapshot read back from `runs.json` (keys in schema order) and the same file
 * freshly loaded are equal.
 */
export function newerCatalogWorkflow(snapshot: WorkflowDef, catalog: readonly WorkflowDef[]): WorkflowDef | undefined {
  if (snapshot.source !== 'file' && snapshot.name !== QUICK_TASK_WORKFLOW.name) return undefined;
  const current = catalog.find((w) => w.name === snapshot.name);
  if (!current || (snapshot.source === 'file' && current.source !== 'file')) return undefined;
  const canonical = (def: WorkflowDef): string | undefined => {
    const parsed = workflowDefSchema.safeParse(def);
    return parsed.success ? JSON.stringify(parsed.data) : undefined;
  };
  const next = canonical(current);
  if (next === undefined || next === canonical(snapshot)) return undefined;
  return current;
}
