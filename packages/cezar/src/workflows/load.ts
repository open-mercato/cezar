import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { graphIssues, graphToSteps, workflowGraphFileSchema } from './graph.ts';
import { BUILT_IN_GRAPH_WORKFLOWS } from './templates.ts';
import {
  QUICK_TASK_WORKFLOW,
  normalizeWorkflowDoc,
  stepsIssue,
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
      // is the v1 `steps`/`skills` format, loaded exactly as before.
      if (doc && typeof doc === 'object' && (doc as { version?: unknown }).version === 2) {
        const graphDoc = workflowGraphFileSchema.safeParse(doc);
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
