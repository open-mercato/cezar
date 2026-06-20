import type { FlowStep, FlowTrigger } from './actions';

/**
 * Starter templates shown in the "+ Flow" dropdown. Picking one prefills the
 * editor with a working starting point — beats staring at a blank flow.
 *
 * Templates are pure data. Skills referenced here must exist (or be added)
 * in the workspace's repo under `.ai/skills/<name>.md`; we list common ones
 * by convention but the user can edit any step before running.
 *
 * Decomposition matters: each step gets its own fresh token budget
 * (`autofix.tokenBudgetPerAttempt`, default 250k). A single mega-step that
 * tries to triage + analyze + fix + push + open PR will blow the budget on
 * anything non-trivial. The autofix template below mirrors the built-in
 * `autofixWorkflow` (packages/core/src/workflows/definitions/autofix.workflow.ts)
 * — five focused steps, each with a narrow read-only or write scope.
 */

/**
 * Shared step list for any flow that fixes a GitHub issue. Steps:
 *   1. verify-in-repo — read-only gate; stops cleanly on NO_ACTION_NEEDED
 *   2. root-cause     — read-only analysis
 *   3. fix            — edits files in the worktree
 *   4. open-pr        — commits, pushes, opens draft PR (emits PR_URL/PR_NUMBER markers)
 *   5. review-pr      — second agent comments on the resulting PR
 *
 * Each step references a skill that must exist at `.ai/skills/<name>.md` in the
 * workspace's repo. The skill body provides the actual instructions; the
 * `systemNotes` here is a per-step scaffolding hint (read-only vs write, what
 * the next step expects). Edit any step in the GUI before running.
 */
function autofixSteps(): FlowStep[] {
  return [
    {
      skill: 'verify-in-repo',
      argsTemplate:
        'Issue #{{input}} — verify whether this is a real, still-unfixed defect.\n\n' +
        '— EXISTING CEZAR PR ON THIS ISSUE (if any) —\n' +
        '{{existingCezarPr}}',
      stopChainIfContains: 'NO_ACTION_NEEDED',
      systemNotes:
        'This is the VERIFY gate. Read-only: do NOT edit files. Use only Read/Grep/Glob ' +
        'and read-only `git log`/`git diff`/`git show`/`git status`.\n\n' +
        'Step 0 — pre-check the marker: if the user message says `EXISTING CEZAR PR ON THIS ISSUE` ' +
        'and the line below it is non-empty and mentions a PR classified as `active`, this issue ' +
        'already has an open Cezar PR. Write `NO_ACTION_NEEDED` on a line by itself with a one-line ' +
        'reason like "PR #N already open (state: changes-requested) — operator should resolve there." ' +
        'Do NOT re-verify or re-fix. Only when the existing-PR line is empty, or its state is ' +
        '`merged` / `closed`, proceed with the normal verification below.\n\n' +
        'Decide quickly whether the issue describes a real, still-unfixed defect on the current ' +
        'branch — as opposed to expected behavior, something already fixed, or a usage error.\n\n' +
        'If no action is needed (already fixed / not a bug / out of scope), write `NO_ACTION_NEEDED` ' +
        'on a line by itself with a one-paragraph reason. The chain will stop cleanly.\n\n' +
        'Otherwise, write a short paragraph confirming it is a real defect with file/commit evidence.',
    },
    {
      skill: 'root-cause',
      argsTemplate:
        'Issue #{{input}} — find the root cause and propose the minimal fix.\n\n' +
        '— PREVIOUS STEP (verify-in-repo) said —\n' +
        '{{previousOutput}}',
      systemNotes:
        'This is the ANALYZE step. Read-only: do NOT edit files.\n\n' +
        'Produce: (1) a one-paragraph summary of the bug, (2) the file(s) that need to change, ' +
        '(3) the proposed minimal change. Keep it tight — the next step implements it.\n\n' +
        'End with `Status: blocked` on its own line if you cannot locate a confident root cause; ' +
        'the chain will stop and surface the failure instead of cascading into a hallucinated fix.',
    },
    {
      skill: 'fix',
      argsTemplate:
        'Issue #{{input}} — implement the fix per the analyzer brief below.\n\n' +
        '— PREVIOUS STEP (root-cause) said —\n' +
        '{{previousOutput}}',
      systemNotes:
        'This is the FIX step. Implement the minimal change EXACTLY as the analyzer described above. ' +
        'Do NOT invent your own root cause; if the brief is unclear or contradicts the repo, end with ' +
        '`Status: blocked` and explain what is missing.\n\n' +
        'Use Edit/Write to change files; run tests with Bash if needed to verify the change holds.\n\n' +
        'Do NOT commit, push, or open a PR — the next step handles that.\n\n' +
        'On the success path, end with `Status: ready` plus a one-paragraph summary of what you changed ' +
        'and which files were touched. On the blocked path, end with `Status: blocked` and a short reason ' +
        '— the chain will stop cleanly.',
    },
    {
      skill: 'open-pr',
      argsTemplate:
        'Issue #{{input}} — commit, push, and open a draft PR for the fix from the previous step.\n\n' +
        '— PREVIOUS STEP (fix) said —\n' +
        '{{previousOutput}}',
      // Default systemNotes (DEFAULT_STEP_NOTES) documents the PR_URL=/PR_NUMBER= marker
      // contract that the review-pr step needs — leave systemNotes unset to inherit it.
      // The skill itself emits `Status: blocked` when there are no changes to commit;
      // the flow runner recognises that marker and stops the chain cleanly.
    },
    {
      skill: 'auto-review-pr',
      argsTemplate:
        'Review PR #{{previousPullRequestNumber}} at {{previousPullRequestUrl}}.\n\n' +
        '— PREVIOUS STEP (open-pr) said —\n' +
        '{{previousOutput}}',
      systemNotes:
        'This is the REVIEW step. Read the PR diff and post a review comment on the PR. ' +
        'Be specific about blockers vs nits. Read-only: do NOT push further commits.\n\n' +
        'If `{{previousPullRequestNumber}}` is empty, the upstream open-pr step did not open a PR — ' +
        'end with `Status: blocked` and a one-line reason. Do not invent a PR number.\n\n' +
        "After posting the review, emit ONE final line so the issue's `cezar:pr-link` marker " +
        "reflects the PR's new state:\n" +
        '  PR_STATE=review              ← clean review, no blockers\n' +
        '  PR_STATE=changes-requested   ← blockers found / changes needed\n' +
        '  PR_STATE=approved            ← LGTM\n' +
        'The marker is what later flow runs see when deciding "this issue already has a PR" — ' +
        'a stale `draft` marker would let a re-run hallucinate a fresh fix attempt.',
    },
  ];
}

export interface FlowTemplate {
  id: string;
  label: string;
  /** One-line description shown next to the label in the dropdown. */
  description: string;
  build: () => {
    name: string;
    steps: FlowStep[];
    triggers: FlowTrigger[];
  };
}

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: 'blank',
    label: 'Blank flow',
    description: 'Start from scratch.',
    build: () => ({
      name: 'new flow',
      steps: [{ skill: '', argsTemplate: '{{input}}' }],
      triggers: [],
    }),
  },
  {
    id: 'fix-and-review',
    label: 'Fix → Review PR (5 steps)',
    description:
      'Decomposed autofix: verify → analyze → fix → open PR → review. Each step gets its own token budget.',
    build: () => ({
      name: 'fix github issue',
      steps: autofixSteps(),
      triggers: [],
    }),
  },
  {
    id: 'triage-and-label',
    label: 'Triage → Label',
    description:
      'Read an incoming issue and apply triage labels. Stops cleanly if no action is needed.',
    build: () => ({
      name: 'triage incoming',
      steps: [
        {
          skill: 'auto-triage',
          argsTemplate: 'Triage issue #{{input}}',
          stopChainIfContains: 'NO_ACTION_NEEDED',
        },
      ],
      triggers: [{ kind: 'issue.opened' }],
    }),
  },
  {
    id: 'on-label-fix',
    label: 'Label trigger → Fix (5 steps)',
    description:
      'Auto-fix any issue that gets the `auto-fix` label, using the decomposed verify → analyze → fix → open PR → review pipeline.',
    build: () => ({
      name: 'fix on label',
      steps: autofixSteps(),
      triggers: [{ kind: 'issue.labeled', label: 'auto-fix' }],
    }),
  },
];
