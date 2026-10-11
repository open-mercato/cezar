import type {
  ShadowForgeFile,
  ShadowIntent,
  ShadowIntentState,
  ShadowLedgerResponse,
  ShadowPromotable,
  ShadowPushRelation,
} from '@open-mercato/cezar-contract';
import { loadConfig } from '../config.ts';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { classifyGh, ghTargetRepo } from './gh-policy.ts';
import { defaultGit, type Git } from './git-redirect.ts';
import { shadowDir, type DecisionLine, type ForgeIntentLine, type IntentLine, type PushIntentLine } from './ledger.ts';
import { readLedger } from './ledger-store.ts';

/**
 * What a shadow run tried to do, as the cockpit shows it (spec `2026-10-06-shadow-runs` § The
 * review surface). Every field here is DERIVED on each read - the policy class from the raw argv,
 * a push's relation from this machine's own remote-tracking refs - because the ledger is written
 * by the agent and a stored verdict would be a verdict the agent wrote.
 *
 * No network: "new" and "fast-forward" are relative to the last fetch. The promotion itself is a
 * plain, non-forced `git push`, so the remote has the final word on anything stale.
 */

export interface ShadowViewContext {
  dataDir: string;
  runId: string;
  repoRoot: string;
  git?: Git;
  /** The project's configured base branch; read from `config.json` when absent. */
  baseBranch?: string | null;
}

export interface LoadedIntent {
  line: IntentLine;
  view: ShadowIntent;
}

/** Characters of a captured body shown for review. A longer body is manual-only: a click must
 *  never publish text the reviewer was not shown. */
const PREVIEW_CHARS = 16_000;
/** Push relations computed per read; past it a push reads `unknown` (and so is manual-only). */
const RELATION_BUDGET = 64;
const ZERO_SHA = /^0+$/;

/** POSIX shell quoting for the copyable command. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function stateOf(decision: DecisionLine | undefined): ShadowIntentState {
  return decision ? decision.decision : 'pending';
}

function decided(decision: DecisionLine | undefined, redact: (text: string) => string): Pick<ShadowIntent, 'decidedAt' | 'detail'> {
  if (!decision) return {};
  return {
    decidedAt: decision.at,
    ...(decision.detail !== undefined ? { detail: redact(decision.detail) } : {}),
  };
}

const shortRef = (ref: string) => ref.replace(/^refs\/(heads|tags)\//, '');

interface PushFacts {
  isProtected(remote: string, branch: string): Promise<boolean>;
  relation(line: PushIntentLine): Promise<ShadowPushRelation>;
}

/** Local git facts about pushes, memoized per read and bounded by RELATION_BUDGET. */
function pushFacts(repoRoot: string, git: Git, baseBranch: string | null): PushFacts {
  const defaults = new Map<string, string | null>();
  let budget = RELATION_BUDGET;
  const defaultBranch = async (remote: string): Promise<string | null> => {
    if (defaults.has(remote)) return defaults.get(remote) ?? null;
    const head = await git(repoRoot, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`]);
    const prefix = `refs/remotes/${remote}/`;
    const target = head.stdout.trim();
    const branch = head.ok && target.startsWith(prefix) ? target.slice(prefix.length) : null;
    defaults.set(remote, branch);
    return branch;
  };
  return {
    // `<remote>/HEAD` is unset in a clone made with `git remote add` + fetch, so the project's base
    // branch and main/master count too: a wrong guess here costs a manual step, not a published push.
    async isProtected(remote, branch) {
      if (branch === 'main' || branch === 'master') return true;
      if (baseBranch !== null && [branch, `${remote}/${branch}`, `refs/heads/${branch}`].includes(baseBranch)) return true;
      return branch === (await defaultBranch(remote));
    },
    async relation(line) {
      if (ZERO_SHA.test(line.sha)) return 'delete';
      if (!line.ref.startsWith('refs/heads/') || budget <= 0) return 'unknown';
      budget -= 1;
      const tracking = await git(repoRoot, [
        'rev-parse', '--verify', '--quiet', `refs/remotes/${line.remote}/${shortRef(line.ref)}^{commit}`,
      ]);
      if (!tracking.ok) return 'new';
      const base = tracking.stdout.trim();
      if (base === line.sha) return 'fast-forward';
      const ancestor = await git(repoRoot, ['merge-base', '--is-ancestor', base, line.sha]);
      return ancestor.ok ? 'fast-forward' : 'diverged';
    },
  };
}

async function pushView(
  line: PushIntentLine,
  decision: DecisionLine | undefined,
  facts: PushFacts,
  redact: (text: string) => string,
): Promise<ShadowIntent> {
  const relation = await facts.relation(line);
  const branch = line.ref.startsWith('refs/heads/') ? shortRef(line.ref) : null;
  const isDefault = branch !== null && (await facts.isProtected(line.remote, branch));

  let promotable: ShadowPromotable = 'manual';
  let reason: string;
  if (relation === 'delete') reason = 'deletes a branch or tag on the remote: run it by hand';
  else if (branch === null) reason = 'pushes a tag or a ref that is not a branch: run it by hand';
  else if (!line.pinned) reason = 'the commit is not in this repository (it was pushed from another clone)';
  else if (isDefault) reason = `targets ${branch}, a default or base branch: work lands there through review`;
  else if (relation === 'diverged') reason = 'not a fast-forward: promoting it would need a force push';
  else if (relation === 'unknown') reason = 'its relation to the remote could not be determined';
  else {
    promotable = 'click';
    reason = relation === 'new' ? 'creates a new branch on the remote' : 'fast-forwards an existing branch';
  }

  const command = relation === 'delete'
    ? `git push ${shellQuote(line.remote)} --delete ${shellQuote(line.ref)}`
    : `git push ${shellQuote(line.remote)} ${line.sha}:${shellQuote(line.ref)}`;
  const summary = relation === 'delete'
    ? `delete ${shortRef(line.ref)} on ${line.remote}`
    : `push ${shortRef(line.ref)} to ${line.remote} (${relation})`;

  return {
    id: line.id,
    at: line.at,
    kind: 'push',
    summary: redact(summary),
    command: redact(command),
    promotable,
    reason,
    state: stateOf(decision),
    ...decided(decision, redact),
    push: { remote: line.remote, ref: line.ref, sha: line.sha, relation, pinned: line.pinned },
  };
}

function flagValue(argv: readonly string[], ...names: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (names.includes(token)) return argv[i + 1];
    const long = names.find((name) => name.startsWith('--') && token.startsWith(`${name}=`));
    if (long) return token.slice(long.length + 1);
  }
  return undefined;
}

function forgeView(line: ForgeIntentLine, decision: DecisionLine | undefined, redact: (text: string) => string): ShadowIntent {
  const verdict = classifyGh(line.argv);
  const repo = ghTargetRepo(line.argv);
  const denied = line.kind === 'denied' || verdict.effect === 'deny';
  let promotable: ShadowPromotable;
  let reason: string;
  if (denied) {
    promotable = 'never';
    reason = verdict.effect === 'deny' ? verdict.reason : 'refused when it was attempted';
  } else if (verdict.effect === 'read') {
    promotable = 'never';
    reason = 'a read-only command: there is nothing to promote';
  } else if (line.files.some((file) => file.truncated)) {
    promotable = 'manual';
    reason = `${verdict.reason}; a file it reads was too large to capture whole`;
  } else if (line.truncated) {
    promotable = 'manual';
    reason = `${verdict.reason}; its arguments were too long to record whole`;
  } else if (line.redacted || line.argv.some((token) => redact(token) !== token) || line.files.some((file) => redact(file.content) !== file.content)) {
    // Display strings are redacted, so a click would publish something the reviewer saw as
    // `[REDACTED]` - or, when the shim already redacted it, publish the marker itself.
    promotable = 'manual';
    reason = `${verdict.reason}; it carries a value that looks like a secret`;
  } else if (line.files.some((file) => file.content.length > PREVIEW_CHARS)) {
    promotable = 'manual';
    reason = `${verdict.reason}; its body is longer than the review preview`;
  } else {
    promotable = verdict.promotable;
    reason = verdict.reason;
  }

  const title = flagValue(line.argv, '--title', '-t');
  const summary = `gh ${verdict.command}${title ? ` "${title.slice(0, 80)}"` : ''}${repo ? ` in ${repo}` : ''}`;
  const files: ShadowForgeFile[] = line.files.map((file) => ({
    flag: file.flag,
    name: file.name,
    bytes: file.bytes,
    truncated: file.truncated,
    preview: redact(file.content.slice(0, PREVIEW_CHARS)),
  }));

  return {
    id: line.id,
    at: line.at,
    kind: denied ? 'denied' : 'forge',
    summary: redact(summary),
    command: redact(['gh', ...line.argv].map(shellQuote).join(' ')),
    promotable,
    reason,
    state: stateOf(decision),
    ...decided(decision, redact),
    forge: {
      tool: 'gh',
      argv: line.argv.map(redact),
      ...(repo !== undefined ? { repo } : {}),
      files,
    },
  };
}

export async function loadShadowIntents(context: ShadowViewContext): Promise<{ entries: LoadedIntent[]; truncated: boolean }> {
  const snapshot = readLedger(shadowDir(context.dataDir, context.runId));
  const baseBranch = context.baseBranch !== undefined ? context.baseBranch : ((await loadConfig(context.repoRoot)).baseBranch ?? null);
  const facts = pushFacts(context.repoRoot, context.git ?? defaultGit, baseBranch);
  const secrets = collectSecretValues();
  const redact = (text: string) => redactSecrets(text, secrets);
  const entries: LoadedIntent[] = [];
  for (const line of snapshot.intents) {
    const decision = snapshot.decisions.get(line.id);
    const view = line.kind === 'push'
      ? await pushView(line, decision, facts, redact)
      : forgeView(line, decision, redact);
    entries.push({ line, view });
  }
  return { entries, truncated: snapshot.truncated };
}

/** `GET /runs/:id/shadow`. An ordinary run answers empty without touching the disk. */
export async function buildShadowLedger(context: ShadowViewContext, isShadow: boolean): Promise<ShadowLedgerResponse> {
  if (!isShadow) return { shadow: false, intents: [], truncated: false };
  const { entries, truncated } = await loadShadowIntents(context);
  return { shadow: true, intents: entries.map((entry) => entry.view), truncated };
}
