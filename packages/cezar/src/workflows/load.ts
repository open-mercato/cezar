import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  QUICK_TASK_WORKFLOW,
  normalizeWorkflowDoc,
  stepsIssue,
  workflowFileSchema,
  type WorkflowDef,
} from './types.js';

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
