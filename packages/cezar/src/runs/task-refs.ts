/**
 * PR/issue-number extraction from a task prompt (spec 2026-07-17-task-auto-naming,
 * step 0): the always-available programmatic layer under the LLM namer. Pure and
 * synchronous — it runs inline at `startRun` and its result both prefixes the
 * heuristic title and cross-checks the namer's structured output (the regex wins
 * every disagreement).
 */

export interface TaskRefs {
  prNumber?: number;
  issueNumber?: number;
  /** A number present in the task whose kind (PR vs issue) is not determinable —
   *  a bare `469` argument or a plain `#469`. Still usable as a title prefix. */
  ambiguousNumber?: number;
}

export const MAX_REF = 10_000_000; // sanity bound — GitHub numbers are far below this

function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < MAX_REF ? n : undefined;
}

/** First match wins per kind, scanning the whole prompt. */
export function extractTaskRefs(task: string): TaskRefs {
  const refs: TaskRefs = {};
  const text = task ?? '';

  // 1. Explicit URLs — the strongest signal.
  const prUrl = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/i.exec(text);
  if (prUrl) refs.prNumber = num(prUrl[1]);
  const issueUrl = /github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)/i.exec(text);
  if (issueUrl) refs.issueNumber = num(issueUrl[1]);

  // 2. Worded references — covers the GitHub-tab templates verbatim
  //    ("Address GitHub pull request #N", "Fix GitHub issue #N") and free text
  //    ("pr 437", "PR#437", "review pull request 437", "issue #12").
  if (refs.prNumber === undefined) {
    const pr = /\b(?:pull\s+request|pr)\s*#?\s*(\d+)/i.exec(text);
    if (pr) refs.prNumber = num(pr[1]);
  }
  if (refs.issueNumber === undefined) {
    const issue = /\bissue\s*#?\s*(\d+)/i.exec(text);
    if (issue) refs.issueNumber = num(issue[1]);
  }

  // 3. A task that IS a number — the argument-only skill invocation (`469`).
  if (refs.prNumber === undefined && refs.issueNumber === undefined) {
    const bare = /^\s*#?(\d+)\s*$/.exec(text);
    if (bare) refs.ambiguousNumber = num(bare[1]);
    else {
      // 4. Last resort: the first `#N` anywhere.
      const hash = /#(\d+)\b/.exec(text);
      if (hash) refs.ambiguousNumber = num(hash[1]);
    }
  }
  return refs;
}

/** The single number worth prefixing a title with, strongest kind first. */
export function titleRefNumber(refs: TaskRefs): number | undefined {
  return refs.prNumber ?? refs.issueNumber ?? refs.ambiguousNumber;
}

/**
 * Skill-aware disambiguation for a bare number: `469` handed to a *-review-pr
 * skill is a PR; handed to a *-fix-issue skill it is an issue. Only upgrades
 * `ambiguousNumber` — explicit URL/worded matches are never overridden.
 */
export function refineTaskRefs(refs: TaskRefs, skillName?: string): TaskRefs {
  if (refs.ambiguousNumber === undefined || !skillName) return refs;
  const name = skillName.toLowerCase();
  if (/(^|\W)pr(\W|$)|pull-?request/.test(name)) {
    return { ...refs, prNumber: refs.prNumber ?? refs.ambiguousNumber, ambiguousNumber: undefined };
  }
  if (name.includes('issue')) {
    return { ...refs, issueNumber: refs.issueNumber ?? refs.ambiguousNumber, ambiguousNumber: undefined };
  }
  return refs;
}
