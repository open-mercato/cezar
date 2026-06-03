import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Octokit } from '@octokit/rest';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ensureRepoClone, withRepoLock } from './repo-clone';
import type {
  Database,
  LabelAnalysisDraft,
  LabelAnalysisInputsSummary,
  LabelAnalysisResult,
} from './supabase/types';

// Cap on how many issues / PRs we walk for label-usage telemetry. The spec
// asks for "last 100" — we keep that as the default but allow tuning via env
// for sandbox repos where 100 is overkill (or for huge repos where rate-limit
// pressure pushes us lower).
const ISSUES_LIMIT = Number(process.env.CEZAR_LABEL_ANALYSIS_ISSUES) || 100;
const PRS_LIMIT = Number(process.env.CEZAR_LABEL_ANALYSIS_PRS) || 100;
// Concurrency for the per-item event/comment fetch — keeps wall time low
// without burning the secondary-rate-limit budget.
const PER_ITEM_CONCURRENCY = 5;
// Cap on how many comments we forward to the LLM per item. Most label-usage
// signal is in the body + final label set; comments are a tie-breaker.
const COMMENT_SAMPLE_PER_ITEM = 5;
const COMMENT_BODY_CHARS = 400;
const ISSUE_BODY_CHARS = 600;

// Files we scan for label guidance. Globs would be nicer but the set is small
// and these paths are stable across most repos.
const CODEBASE_GUIDE_PATHS = [
  'LABELS.md',
  'LABELS.txt',
  'LABELING.md',
  'CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  '.github/labels.yml',
  '.github/labels.yaml',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE/pull_request_template.md',
];
const CODEBASE_GUIDE_DIRS = ['.github/ISSUE_TEMPLATE'];

const LabelDraftSchema = z.object({
  name: z.string().min(1),
  color: z.string().optional().nullable(),
  description: z.string(),
  when_to_add: z.string(),
  when_to_remove: z.string(),
  add_meaning: z.string(),
  remove_meaning: z.string(),
  exists_on_github: z.boolean(),
});

const LabelAnalysisResultSchema = z.object({
  issue_labels: z.array(LabelDraftSchema),
  pr_labels: z.array(LabelDraftSchema),
  notes: z.string().optional(),
});

export interface ExecuteLabelAnalysisJobParams {
  workspaceId: string;
  jobId: string;
  analysisId: string;
}

interface LabelEvent {
  action: 'added' | 'removed';
  label: string;
  actor: string;
  at: string;
}

interface CondensedItem {
  number: number;
  kind: 'issue' | 'pr';
  title: string;
  state: string;
  author: string;
  body: string;
  current_labels: string[];
  label_events: LabelEvent[];
  comment_count: number;
  comment_sample: Array<{ author: string; body: string }>;
}

/**
 * Phase 0b executor — runs end-to-end synchronously inside a dispatcher tick.
 * NOT a workflow_run: label analysis has no per-issue target, no agent steps,
 * and no PR outcome, so it routes around executeWorkflowJob and writes only
 * to `workspace_label_analyses`.
 */
export async function executeLabelAnalysisJob(
  adminSupabase: SupabaseClient<Database>,
  params: ExecuteLabelAnalysisJobParams,
): Promise<void> {
  const { workspaceId, jobId, analysisId } = params;

  const finishJob = async (status: Database['public']['Tables']['jobs']['Row']['status']): Promise<void> => {
    // Drop the lease (migration 0025) on completion.
    await adminSupabase.from('jobs').update({
      status,
      claim_expires_at: null,
      updated_at: new Date().toISOString(),
    }).eq('id', jobId);
  };

  const failAnalysis = async (message: string): Promise<void> => {
    await adminSupabase
      .from('workspace_label_analyses')
      .update({
        status: 'failed',
        error: message,
        finished_at: new Date().toISOString(),
      })
      .eq('id', analysisId);
    await finishJob('failed');
  };

  try {
    // ── mark running ───────────────────────────────────────────────────
    await adminSupabase
      .from('workspace_label_analyses')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', analysisId);

    const { data: ws, error: wsErr } = await adminSupabase
      .from('workspaces')
      .select('repo_owner, repo_name')
      .eq('id', workspaceId)
      .single();
    if (wsErr || !ws) throw new Error(`workspace ${workspaceId} not found: ${wsErr?.message ?? ''}`);

    const owner = ws.repo_owner;
    const repo = ws.repo_name;

    const githubToken = await resolveWorkspaceGithubToken(workspaceId, owner, adminSupabase);
    if (!githubToken) throw new Error('no github token available for workspace');

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not set');

    const octokit = new Octokit({ auth: githubToken });

    // ── 1. current GitHub labels ──────────────────────────────────────
    const labels = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
      owner,
      repo,
      per_page: 100,
    });

    // ── 2. codebase guide files ───────────────────────────────────────
    let codebaseGuides: Array<{ path: string; content: string }> = [];
    try {
      // Hold the per-repo worktree lock across the clone + read so a sibling
      // triage/autofix job can't checkout/reset the tree mid-read.
      codebaseGuides = await withRepoLock(owner, repo, async () => {
        const repoRoot = await ensureRepoClone(owner, repo, githubToken);
        return readCodebaseGuides(repoRoot);
      });
    } catch (err) {
      // Non-fatal — the analysis just runs without codebase guides.
      console.warn(
        `[label-analysis] codebase fetch failed for ${owner}/${repo}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // ── 3. last N issues + last N PRs (state=all) ─────────────────────
    // GitHub's `issues.listForRepo` returns PRs too; filter them out and
    // list PRs separately to get a balanced sample of both.
    const [rawIssues, prList] = await Promise.all([
      octokit.rest.issues
        .listForRepo({
          owner,
          repo,
          state: 'all',
          per_page: ISSUES_LIMIT,
          sort: 'updated',
          direction: 'desc',
        })
        .then((r) => r.data.filter((i) => !i.pull_request).slice(0, ISSUES_LIMIT)),
      octokit.rest.pulls
        .list({
          owner,
          repo,
          state: 'all',
          per_page: PRS_LIMIT,
          sort: 'updated',
          direction: 'desc',
        })
        .then((r) => r.data.slice(0, PRS_LIMIT)),
    ]);

    const issues = await condenseItems(
      octokit,
      owner,
      repo,
      rawIssues.map((i) => ({
        number: i.number,
        title: i.title ?? '',
        state: i.state ?? 'unknown',
        author: i.user?.login ?? 'ghost',
        body: i.body ?? '',
        labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean),
        comments: i.comments ?? 0,
      })),
      'issue',
    );
    const prs = await condenseItems(
      octokit,
      owner,
      repo,
      prList.map((p) => ({
        number: p.number,
        title: p.title ?? '',
        state: p.state ?? 'unknown',
        author: p.user?.login ?? 'ghost',
        body: p.body ?? '',
        labels: (p.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
        comments: 0, // pulls.list doesn't surface comment count; we fetch lazily inside condenseItems
      })),
      'pr',
    );

    // ── 4. build prompt + call Claude ─────────────────────────────────
    const prompt = buildPrompt({
      owner,
      repo,
      labels: labels.map((l) => ({
        name: l.name,
        color: l.color ?? null,
        description: l.description ?? null,
      })),
      codebaseGuides,
      items: [...issues, ...prs],
    });

    const anthropic = new Anthropic({ apiKey: anthropicKey });
    const model = process.env.CEZAR_LABEL_ANALYSIS_MODEL || 'claude-sonnet-4-6';
    const response = await anthropic.messages.create({
      model,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    const rawText = textBlock && textBlock.type === 'text' ? textBlock.text : '';

    const parsed = parseLLMJson(rawText);
    if (!parsed) {
      throw new Error('Claude returned a response that could not be parsed as label-analysis JSON');
    }

    // Cross-check: make sure every label name from the GitHub labels list is
    // represented somewhere in the result. If the model dropped some, append
    // them as exists_on_github with empty guidance so the user can fill in.
    const ghLabelSet = new Set(labels.map((l) => l.name.toLowerCase()));
    const seen = new Set<string>();
    for (const d of [...parsed.issue_labels, ...parsed.pr_labels]) seen.add(d.name.toLowerCase());
    for (const l of labels) {
      if (!seen.has(l.name.toLowerCase())) {
        const draft: LabelAnalysisDraft = {
          name: l.name,
          color: l.color ?? null,
          description: l.description ?? '',
          when_to_add: '',
          when_to_remove: '',
          add_meaning: '',
          remove_meaning: '',
          exists_on_github: true,
        };
        parsed.issue_labels.push(draft);
      }
    }
    // Hydrate colors from GitHub on labels the model didn't supply colors for.
    const colorByName = new Map(labels.map((l) => [l.name.toLowerCase(), l.color]));
    const hydrate = (d: LabelAnalysisDraft): LabelAnalysisDraft => {
      if (d.color) return d;
      const c = colorByName.get(d.name.toLowerCase());
      return c ? { ...d, color: c } : d;
    };
    parsed.issue_labels = parsed.issue_labels.map(hydrate);
    parsed.pr_labels = parsed.pr_labels.map(hydrate);
    // Stamp exists_on_github accurately regardless of what the model claimed.
    const stamp = (d: LabelAnalysisDraft): LabelAnalysisDraft => ({
      ...d,
      exists_on_github: ghLabelSet.has(d.name.toLowerCase()),
    });
    parsed.issue_labels = parsed.issue_labels.map(stamp);
    parsed.pr_labels = parsed.pr_labels.map(stamp);

    const inputsSummary: LabelAnalysisInputsSummary = {
      github_labels: labels.length,
      issues_scanned: issues.length,
      prs_scanned: prs.length,
      codebase_files: codebaseGuides.map((g) => g.path),
    };

    await adminSupabase
      .from('workspace_label_analyses')
      .update({
        status: 'completed',
        result: parsed,
        inputs_summary: inputsSummary,
        finished_at: new Date().toISOString(),
      })
      .eq('id', analysisId);
    await finishJob('done');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[label-analysis] failed:', message);
    await failAnalysis(message).catch(() => {});
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function resolveWorkspaceGithubToken(
  workspaceId: string,
  owner: string,
  supabase: SupabaseClient<Database>,
): Promise<string | null> {
  // 1. Try the GitHub App installation token (preferred — least-privilege).
  try {
    const { GitHubAppService } = await import('@cezar/core');
    if (GitHubAppService.isConfigured()) {
      return await new GitHubAppService().getInstallationToken(owner);
    }
  } catch (err) {
    console.warn(
      '[label-analysis] installation token fetch failed; falling back to admin OAuth token:',
      err instanceof Error ? err.message : err,
    );
  }
  // 2. Fall back to any workspace admin's OAuth token.
  const { data: admins } = await supabase
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('role', 'admin');
  if (admins && admins.length > 0) {
    const ids = admins.map((a) => a.user_id);
    const { data: tokens } = await supabase
      .from('user_github_tokens')
      .select('provider_token')
      .in('user_id', ids)
      .limit(1);
    const token = tokens?.[0]?.provider_token;
    if (token) return token;
  }
  // 3. Ambient env-var token (CLI / local dev).
  return process.env.GITHUB_TOKEN ?? null;
}

async function readCodebaseGuides(repoRoot: string): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  const tryRead = async (rel: string): Promise<void> => {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) return;
    try {
      const content = await readFile(abs, 'utf8');
      // Skip empty or huge files — keep the prompt budget sane.
      if (!content.trim()) return;
      out.push({ path: rel, content: content.slice(0, 8000) });
    } catch {
      /* ignore */
    }
  };

  for (const path of CODEBASE_GUIDE_PATHS) {
    await tryRead(path);
  }
  for (const dir of CODEBASE_GUIDE_DIRS) {
    const abs = join(repoRoot, dir);
    if (!existsSync(abs)) continue;
    try {
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(abs);
      for (const e of entries) {
        if (e.startsWith('.')) continue;
        await tryRead(join(dir, e));
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

interface ItemSeed {
  number: number;
  title: string;
  state: string;
  author: string;
  body: string;
  labels: string[];
  comments: number;
}

async function condenseItems(
  octokit: Octokit,
  owner: string,
  repo: string,
  seeds: ItemSeed[],
  kind: 'issue' | 'pr',
): Promise<CondensedItem[]> {
  const out: CondensedItem[] = [];

  // Process in concurrency-limited batches to stay polite with rate limits.
  for (let i = 0; i < seeds.length; i += PER_ITEM_CONCURRENCY) {
    const batch = seeds.slice(i, i + PER_ITEM_CONCURRENCY);
    const condensed = await Promise.all(batch.map((seed) => condenseOne(octokit, owner, repo, seed, kind)));
    out.push(...condensed);
  }
  return out;
}

async function condenseOne(
  octokit: Octokit,
  owner: string,
  repo: string,
  seed: ItemSeed,
  kind: 'issue' | 'pr',
): Promise<CondensedItem> {
  // Issue events endpoint returns events for both issues and PRs (PRs are
  // issues under the hood). `labeled` / `unlabeled` are what we want.
  const labelEvents: LabelEvent[] = [];
  try {
    const events = await octokit.rest.issues.listEvents({
      owner,
      repo,
      issue_number: seed.number,
      per_page: 100,
    });
    for (const e of events.data) {
      if (e.event === 'labeled' || e.event === 'unlabeled') {
        const labelName = (e as { label?: { name?: string } }).label?.name;
        if (!labelName) continue;
        labelEvents.push({
          action: e.event === 'labeled' ? 'added' : 'removed',
          label: labelName,
          actor: e.actor?.login ?? 'ghost',
          at: e.created_at ?? '',
        });
      }
    }
  } catch {
    /* ignore — fall through with empty events */
  }

  // Comment sample: only if there are any, and only the last few.
  const commentSample: Array<{ author: string; body: string }> = [];
  if (seed.comments > 0 || kind === 'pr') {
    try {
      const comments = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: seed.number,
        per_page: COMMENT_SAMPLE_PER_ITEM,
      });
      for (const c of comments.data.slice(-COMMENT_SAMPLE_PER_ITEM)) {
        commentSample.push({
          author: c.user?.login ?? 'ghost',
          body: (c.body ?? '').slice(0, COMMENT_BODY_CHARS),
        });
      }
    } catch {
      /* ignore */
    }
  }

  return {
    number: seed.number,
    kind,
    title: seed.title,
    state: seed.state,
    author: seed.author,
    body: seed.body.slice(0, ISSUE_BODY_CHARS),
    current_labels: seed.labels,
    label_events: labelEvents,
    comment_count: seed.comments,
    comment_sample: commentSample,
  };
}

function buildPrompt(args: {
  owner: string;
  repo: string;
  labels: Array<{ name: string; color: string | null; description: string | null }>;
  codebaseGuides: Array<{ path: string; content: string }>;
  items: CondensedItem[];
}): string {
  const { owner, repo, labels, codebaseGuides, items } = args;

  const lines: string[] = [];
  lines.push(`You are analyzing how labels are used in the GitHub repository ${owner}/${repo}.`);
  lines.push('Your output is a labeling guide that will be saved as the workspace catalog and');
  lines.push('shown to a human for review. Be concrete and base every claim on the evidence below.');
  lines.push('');
  lines.push('## Current labels in the repo');
  if (labels.length === 0) {
    lines.push('(none)');
  } else {
    for (const l of labels) {
      lines.push(`- ${l.name}${l.color ? ` (color #${l.color})` : ''}${l.description ? `: ${l.description}` : ''}`);
    }
  }
  lines.push('');

  lines.push('## Codebase guidance files');
  if (codebaseGuides.length === 0) {
    lines.push('(none found)');
  } else {
    for (const g of codebaseGuides) {
      lines.push(`### ${g.path}`);
      lines.push(g.content);
      lines.push('');
    }
  }
  lines.push('');

  lines.push('## Recent activity — issues and PRs');
  lines.push(
    'For each item: title, state, author, body excerpt, the current label set, the chronological',
    'label add/remove timeline, and a small comment sample.',
  );
  for (const it of items) {
    lines.push('');
    lines.push(`### ${it.kind.toUpperCase()} #${it.number} — ${it.title}`);
    lines.push(`state=${it.state} author=${it.author} current_labels=[${it.current_labels.join(', ')}]`);
    if (it.body) {
      lines.push('body:');
      lines.push(it.body);
    }
    if (it.label_events.length > 0) {
      lines.push('label timeline:');
      for (const ev of it.label_events) {
        lines.push(`- ${ev.at} ${ev.actor} ${ev.action} "${ev.label}"`);
      }
    }
    if (it.comment_sample.length > 0) {
      lines.push('comment sample:');
      for (const c of it.comment_sample) {
        lines.push(`- @${c.author}: ${c.body}`);
      }
    }
  }
  lines.push('');

  lines.push('## Task');
  lines.push('Produce two lists — `issue_labels` and `pr_labels` — describing every label that');
  lines.push('appears in either the current repo labels or the timeline events above. For each label, infer:');
  lines.push('- description: a one-sentence purpose');
  lines.push('- when_to_add: the concrete trigger conditions (what state of the issue/PR justifies the label)');
  lines.push('- when_to_remove: the concrete conditions to remove it (or "never" / "when closed" etc.)');
  lines.push('- add_meaning: the semantic meaning of *adding* it (what state transition it signals)');
  lines.push('- remove_meaning: the semantic meaning of *removing* it (what state transition it signals)');
  lines.push('- exists_on_github: true iff the label name appears in the "Current labels" section above');
  lines.push('');
  lines.push('Rules:');
  lines.push('- Use the codebase guidance files as authoritative when they describe a label.');
  lines.push('- A label may appear in both lists if usage differs between issues and PRs; otherwise put it');
  lines.push('  in the list where it is used most.');
  lines.push('- Do not invent labels that do not appear in the inputs.');
  lines.push('- Keep each text field to 1–2 sentences. Be specific to this repo, not generic.');
  lines.push('');
  lines.push('Return STRICT JSON. No prose, no markdown fences. Shape:');
  lines.push('{');
  lines.push('  "issue_labels": LabelDraft[],');
  lines.push('  "pr_labels": LabelDraft[],');
  lines.push('  "notes": string  // optional, <=2 sentences of overall observations');
  lines.push('}');
  lines.push('where LabelDraft = {');
  lines.push('  "name": string, "color": string|null, "description": string,');
  lines.push('  "when_to_add": string, "when_to_remove": string,');
  lines.push('  "add_meaning": string, "remove_meaning": string,');
  lines.push('  "exists_on_github": boolean');
  lines.push('}');

  return lines.join('\n');
}

function parseLLMJson(raw: string): LabelAnalysisResult | null {
  const tryParse = (text: string): LabelAnalysisResult | null => {
    try {
      const json = JSON.parse(text);
      return LabelAnalysisResultSchema.parse(json) as LabelAnalysisResult;
    } catch {
      return null;
    }
  };

  // Strip markdown fences if present.
  const cleaned = raw.replace(/^```json?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
  const direct = tryParse(cleaned);
  if (direct) return direct;

  // Last-ditch: extract the largest {...} block.
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    const extracted = tryParse(match[0]);
    if (extracted) return extracted;
  }
  return null;
}
