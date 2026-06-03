import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import type { AgentRunRecord } from '@cezar/core';

/**
 * Local mirror of a workflow-engine run, written by the CLI's autofix path when
 * `config.workflow.useEngine` is on. The web cockpit (`/cockpit`) is the SaaS
 * equivalent backed by `workflow_runs`/`agent_runs`; this file is the solo-CLI
 * stand-in so `cezar runs` has something to show.
 */
export interface LocalRunStep {
  stepId: string;
  iteration: number;
  backend: string;
  model: string;
  status: string;
  summary?: string;
  error?: string;
  tokensUsed: number;
}

export interface LocalRunSummary {
  id: string;
  workflow: string;
  issueNumber: number;
  startedAt: string;
  finishedAt: string;
  status: string;
  steps: LocalRunStep[];
  outcome: string;
}

/** `<store dir or cwd>/.cezar/runs/`. `storePath` is e.g. `.issue-store`. */
export function runsDir(storePath?: string): string {
  const base = storePath ? dirname(resolve(storePath)) : process.cwd();
  return join(base, '.cezar', 'runs');
}

export function recordsToSteps(records: AgentRunRecord[]): LocalRunStep[] {
  return records.map((r) => ({
    stepId: r.stepId,
    iteration: r.iteration,
    backend: r.backend,
    model: r.model,
    status: r.status,
    summary: r.summary,
    error: r.error,
    tokensUsed: r.tokensUsed,
  }));
}

export async function writeRunSummary(dir: string, summary: LocalRunSummary): Promise<string> {
  await mkdir(dir, { recursive: true });
  const stamp = summary.startedAt.replace(/[:.]/g, '-');
  const file = join(dir, `${stamp}-issue-${summary.issueNumber}.json`);
  await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return file;
}

export async function listRunSummaries(dir: string): Promise<LocalRunSummary[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const jsonNames = names.filter((n) => n.endsWith('.json'));
  // Parallelize the per-file reads — a long-lived store can accumulate
  // hundreds of run files, and sequential disk I/O makes `cezar runs` lag.
  const results = await Promise.all(
    jsonNames.map(async (name) => {
      try {
        const raw = await readFile(join(dir, name), 'utf8');
        return JSON.parse(raw) as LocalRunSummary;
      } catch {
        // Skip unreadable/corrupt files.
        return null;
      }
    }),
  );
  const out = results.filter((r): r is LocalRunSummary => r !== null);
  // Newest first.
  out.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  return out;
}
