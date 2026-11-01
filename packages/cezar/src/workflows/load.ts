import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { graphIssues, graphToSteps, workflowGraphFileSchema } from './graph.ts';
import { BUILT_IN_GRAPH_WORKFLOWS } from './templates.ts';
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
      const doc: unknown = parseYaml(raw);
      // `version: 2` is a graph workflow (spec 2026-09-30-workflow-node-editor); anything else
      // is the v1 `steps`/`skills` format, loaded exactly as before. A hand-edited file may
      // quote the version (`version: "2"`) — treated the same as the numeric literal, or this
      // falls through to a confusing v1 "missing steps" error instead.
      const docVersion = doc && typeof doc === 'object' ? (doc as { version?: unknown }).version : undefined;
      if (doc && typeof doc === 'object' && (docVersion === 2 || docVersion === '2')) {
        const graphDoc = workflowGraphFileSchema.safeParse({ ...(doc as object), version: 2 });
        if (!graphDoc.success) {
          issues.push({ path, message: graphDoc.error.issues.map((i) => i.message).join('; ') });
          continue;
        }
        const problems = graphIssues(graphDoc.data);
        if (problems.length) {
          issues.push({ path, message: problems.join('; ') });
          continue;
        }
        const { version, name, description, nodes, edges, layout } = graphDoc.data;
        void version;
        fromFiles.push({
          name,
          ...(description ? { description } : {}),
          steps: graphToSteps(graphDoc.data),
          graph: { nodes, edges, ...(layout ? { layout } : {}) },
          source: 'file',
          path,
        });
        continue;
      }
      const parsed = workflowFileSchema.safeParse(doc);
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
    ...[QUICK_TASK_WORKFLOW, ...BUILT_IN_GRAPH_WORKFLOWS].filter((w) => !fileNames.has(w.name)),
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
