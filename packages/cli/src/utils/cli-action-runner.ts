import { readdir, readFile } from 'node:fs/promises';
import { resolve, basename, extname, join } from 'node:path';
import chalk from 'chalk';
import {
  DEFAULT_ACTIONS,
  GitHubService,
  IssueStore,
  discoverBuiltinSkills,
  formatOpenIssuesKb,
  runAction,
  type ActionDef,
  type ActionTarget,
  type ActionTrigger,
  type Config,
  type StoredIssue,
} from '@cezar/core';
import type { EffectName } from '@cezar/core';
import { createDryRunGitHub } from './dry-run-github.js';

/**
 * The selection strategy for which issues a one-shot run targets.
 */
export type IssueScope =
  | { kind: 'single'; number: number }
  | { kind: 'all' }
  | { kind: 'unanalyzed' };

export interface CliRunOptions {
  scope: IssueScope;
  /** Apply effects to GitHub. Without --apply, runs are dry-run by default. */
  apply: boolean;
  /** Force dry-run (overrides apply). */
  dryRun: boolean;
}

/**
 * Load the merged action catalog: the built-in defaults plus any user-defined
 * actions found at `<repoRoot>/.ai/actions/**\/*.md`.
 * Markdown frontmatter mirrors the SQL columns one-for-one. The optional
 * `suggested-flow` key maps to `suggestedFlowId` — parsed but inert locally
 * (the CLI has no job queue; the suggest-workflow effect degrades to a
 * "not supported in this environment" summary).
 */
export async function loadActionCatalog(repoRoot: string = process.cwd()): Promise<ActionDef[]> {
  const userActions = await discoverUserActions(resolve(repoRoot, '.ai/actions'));
  const byName = new Map<string, ActionDef>();
  for (const a of DEFAULT_ACTIONS) byName.set(a.name, a);
  for (const a of userActions) byName.set(a.name, a);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function discoverUserActions(dir: string): Promise<ActionDef[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return [];
  }
  const mdFiles = entries.filter((rel) => extname(rel).toLowerCase() === '.md');
  const actions: ActionDef[] = [];
  for (const rel of mdFiles) {
    const absPath = join(dir, rel);
    let raw: string;
    try {
      raw = await readFile(absPath, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseActionMarkdown(raw, basename(rel, extname(rel)));
    if (parsed) actions.push(parsed);
  }
  return actions;
}

interface Frontmatter {
  [key: string]: string | string[] | number | boolean | null;
}

function parseActionMarkdown(raw: string, fallbackName: string): ActionDef | null {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    return null;
  }
  const end = text.indexOf('\n---', 4);
  if (end === -1) return null;
  const block = text.slice(4, end);
  const afterDelimiter = text.indexOf('\n', end + 1);
  const body = (afterDelimiter === -1 ? '' : text.slice(afterDelimiter + 1)).trim();
  const fm = parseFrontmatterBlock(block);

  const name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : fallbackName;
  const target = fm.target === 'pr' ? 'pr' : 'issue';
  const skillRefs = toStringArray(fm.skill_refs);
  const triggers = toStringArray(fm.triggers) as ActionTrigger[];
  const effects =
    fm.effects === undefined || fm.effects === null
      ? null
      : (toStringArray(fm.effects) as EffectName[]);

  return {
    id: '',
    workspaceId: '',
    name,
    kind: 'user',
    description: typeof fm.description === 'string' ? fm.description : null,
    systemPrompt: body,
    skillRefs,
    target,
    triggers: triggers.length > 0 ? triggers : ['manual'],
    effects,
    outputSchema: null,
    enabled: fm.enabled === false ? false : true,
    suggestedFlowId:
      typeof fm['suggested-flow'] === 'string' && fm['suggested-flow'].trim()
        ? fm['suggested-flow'].trim()
        : null,
  };
}

function parseFrontmatterBlock(block: string): Frontmatter {
  const out: Frontmatter = {};
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();
    if (rest === '') {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        items.push(stripQuotes(lines[i + 1].replace(/^\s*-\s+/, '').trim()));
        i++;
      }
      out[key] = items;
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      out[key] = inner
        ? inner
            .split(',')
            .map((s) => stripQuotes(s.trim()))
            .filter(Boolean)
        : [];
      continue;
    }
    if (rest === 'true' || rest === 'false') {
      out[key] = rest === 'true';
      continue;
    }
    out[key] = stripQuotes(rest);
  }
  return out;
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ─── Running an action across issues ───────────────────────────────────────

/**
 * The "load store, pick issues, build target, call runAction, print result"
 * loop shared by `cezar run` and the interactive hub.
 */
export async function runActionAcrossIssues(
  action: ActionDef,
  opts: CliRunOptions,
  config: Config,
): Promise<{ runs: number; ok: number; failed: number }> {
  const store = await IssueStore.loadOrNull(config.store.path);
  if (!store) {
    console.error(chalk.red("Store not found. Run 'cezar init' first."));
    return { runs: 0, ok: 0, failed: 0 };
  }
  const meta = store.getMeta();
  if (!config.github.owner) config.github.owner = meta.owner;
  if (!config.github.repo) config.github.repo = meta.repo;

  const issues = selectIssues(store.getIssues(), action, opts.scope);
  if (issues.length === 0) {
    console.log(chalk.dim('  No issues match the selected scope.'));
    return { runs: 0, ok: 0, failed: 0 };
  }

  const apply = opts.apply && !opts.dryRun;
  const realGithub = new GitHubService(config);
  const github = apply ? realGithub : createDryRunGitHub(realGithub);
  const skills = await discoverBuiltinSkills();

  console.log(
    `\n  ${chalk.bold(action.name)} · ${issues.length} issue${issues.length === 1 ? '' : 's'} · ${apply ? chalk.yellow('apply') : chalk.dim('dry-run')}\n`,
  );

  let ok = 0;
  let failed = 0;
  for (const issue of issues) {
    const target: ActionTarget = {
      kind: 'issue',
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels,
      htmlUrl: issue.htmlUrl,
      comments: formatStoredComments(issue),
    };
    try {
      const result = await runAction(action, target, {
        skills,
        effectCtx: {
          github,
          targetNumber: issue.number,
          supabase: undefined,
        },
        contextProviders: buildStoreContextProviders(store, issue.number),
      });
      ok++;
      const effectLine =
        result.effectsApplied.length === 0
          ? chalk.dim('(no effects)')
          : result.effectsApplied.map((e) => `${e.call.effect} → ${e.summary}`).join('; ');
      const text = result.text ? `\n      ${chalk.dim(result.text.split('\n')[0])}` : '';
      console.log(`  ${chalk.green('ok')}  #${issue.number}  ${effectLine}${text}`);
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  ${chalk.red('err')} #${issue.number}  ${message}`);
    }
  }

  console.log(`\n  ${chalk.bold('summary')} · ${ok} ok · ${failed} failed\n`);
  return { runs: issues.length, ok, failed };
}

const OPEN_ISSUES_KB_CAP = 100;

/**
 * Context-provider map resolved by the core runner against each action's
 * `contextRefs`. `open-issues` builds the open-issue knowledge base from the
 * local store: open issues lower-numbered than the target (the dedupe rule's
 * "lower-numbered original"), newest first, capped at 100; summaries prefer
 * the stored digest over a body excerpt.
 */
function buildStoreContextProviders(
  store: IssueStore,
  targetNumber: number,
): Record<string, () => Promise<string>> {
  return {
    'open-issues': async () => {
      const open = store
        .getIssues()
        .filter((i) => i.state === 'open' && i.number < targetNumber)
        .sort((a, b) => b.number - a.number);
      return formatOpenIssuesKb(
        open.map((i) => ({
          number: i.number,
          title: i.title,
          summary: i.digest?.summary ?? i.body,
        })),
        { cap: OPEN_ISSUES_KB_CAP },
      );
    },
  };
}

function selectIssues(all: StoredIssue[], action: ActionDef, scope: IssueScope): StoredIssue[] {
  if (scope.kind === 'single') {
    return all.filter((i) => i.number === scope.number);
  }
  if (scope.kind === 'all') return all;
  return all.filter((i) => !isAnalyzedFor(i, action));
}

/**
 * Heuristic "has this issue already been analyzed by this action?" check.
 * The fixed-shape `IssueAnalysis` schema means we look up an action-specific
 * timestamp field by convention; actions without a known marker default to
 * "always run" (returning false here keeps --unanalyzed behaving sensibly).
 */
function isAnalyzedFor(issue: StoredIssue, action: ActionDef): boolean {
  const a = issue.analysis;
  switch (action.name) {
    case 'duplicates':
      return a.duplicatesAnalyzedAt != null;
    case 'priority':
      return a.priorityAnalyzedAt != null;
    case 'auto-label':
      return a.labelsAnalyzedAt != null;
    case 'missing-info':
      return a.missingInfoAnalyzedAt != null;
    case 'recurring-questions':
      return a.recurringAnalyzedAt != null;
    case 'good-first-issue':
      return a.goodFirstIssueAnalyzedAt != null;
    case 'security':
      return a.securityAnalyzedAt != null;
    case 'stale':
      return a.staleAnalyzedAt != null;
    case 'quality':
      return a.qualityAnalyzedAt != null;
    case 'claim-detector':
      return a.claimDetectedAt != null;
    case 'categorize':
      return a.featureCategoryAnalyzedAt != null;
    case 'done-detector':
      return a.doneAnalyzedAt != null;
    case 'bug-detector':
      return a.bugAnalyzedAt != null;
    case 'contributor-welcome':
      return a.welcomeCommentPostedAt != null;
    default:
      return false;
  }
}

function formatStoredComments(issue: StoredIssue): string | undefined {
  if (!issue.comments || issue.comments.length === 0) return undefined;
  return issue.comments.map((c) => `@${c.author} (${c.createdAt}):\n${c.body}`).join('\n\n---\n\n');
}
