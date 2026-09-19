/** Playbook text for the built-in Self-Heal skill. */
export const SELF_HEAL_SKILL_NAME = 'cezar-self-heal';

export const SELF_HEAL_SKILL_BODY = `# Self-Heal Loop

You are running a **Self-Heal** cycle for this repository. Goal: find concrete defects, fix them with parallel candidates, prove each fix with an **engine-run check** (not your narrative), pick a winner, open a **draft PR**. You never merge.

## Preconditions

- \`CEZ_API_URL\`, \`CEZ_PROJECT_ID\`, \`CEZ_BIN\`, \`CEZ_TASK_ID\` are set.
- Dispatch is on (\`cez task create\` works). If create is refused, stop and report — do not fan out through private sub-agents.

## Cycle ledger

1. Create a cycle:
   \`\`\`
   curl -sS -X POST "$CEZ_API_URL/api/v1/p/$CEZ_PROJECT_ID/heal" \\
     -H 'content-type: application/json' \\
     -d '{"brief":"<objective>","successCriteria":"<shell command that exits 0 when fixed>","maxCandidates":5,"budgetUsd":5,"rootRunId":"'"$CEZ_TASK_ID"'"}'
   \`\`\`
2. Keep the returned \`id\` as \`CYCLE_ID\`. Patch status as you move: \`scouting\` → \`spawning\` → \`verifying\` → \`reviewing\` → \`proposing\` → \`done\`.

## Steps

### 1. Scout
- Prefer open GitHub issues (labels like \`bug\`, \`good first issue\`) or failing local tests.
- Write 1–5 **independent** candidates into the cycle (\`PATCH .../heal/$CYCLE_ID\` with \`candidates\`). Each needs a narrow objective and the same \`successCriteria\` shell when possible.

### 2. Spawn
- For each candidate, \`node "$CEZ_BIN" task create "<objective>" --title "<short>" --budget <slice> --success "<criteria>" --evidence "check exit 0"\`.
- Cap in-flight children (engine default 4). Commit your own work before dispatching.
- Record each child \`runId\` back onto the candidate via PATCH.

### 3. Verify (engine truth)
- When a child reports done, **you** re-run \`successCriteria\` in the child's worktree (or ask the parent tree after merge-into-parent).
- PATCH the candidate: \`status: passed|failed\`, \`checkExitCode\`, short \`checkOutput\`.
- A narrative "done" without exit 0 is a **failed** candidate. Retry once or escalate model — never rubber-stamp.

### 4. Review
- For the best passed candidate(s), \`node "$CEZ_BIN" task create "Review <run>" --kind review --review-of <runId>\`.
- Keep only \`verdict: approve\`.

### 5. Propose
- Merge the winner into **your** branch (never the base branch).
- \`gh pr create --draft\` with a summary of scout → scoreboard → checks.
- PATCH cycle: \`winnerRunId\`, \`draftPrUrl\`, \`status: done\`.

## Hard rules

- Human owns merge. Draft PR only.
- Independent scopes only — coupled work stays in one task.
- Watch Control Tower spend/RSS; if governor pauses you, stop spawning and report.
- Prefer cheap models for narrow leaf fixes; frontier for ambiguous multi-file work.
`;
