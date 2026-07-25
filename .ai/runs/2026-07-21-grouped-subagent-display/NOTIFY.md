# Notify — 2026-07-21-grouped-subagent-display

> Append-only log. Every entry is UTC-timestamped. Never rewrite prior entries.

## 2026-07-21T10:09:58Z — run started
- Brief: implement `.ai/specs/2026-07-20-grouped-subagent-display.md` end to end (all 3 phases /
  7 steps) — grouped sub-agent display for issue #474, ask 3. Spec + mockups already merged (#522).
- External skill URLs: none
- Mode: Spec-implementation run (linked spec under `.ai/specs/`, explicit phases/steps).
- Reused the current linked worktree; branch `feat/grouped-subagent-display` off `origin/main`.

## 2026-07-21T10:22:30Z — checkpoint 1 (Phase 1 complete)
- Steps covered: 1.1 … 1.4 (`bd205e4` … `e021935`).
- Validation: typecheck, `npm test` (2975), `npm run test:unit` (30), design-guardian — all green.
- UI verified in a real browser via agent-browser against the dry-run cockpit: the dock renders
  `Agents · 2/2` with both agents, type badges, activity lines and tool counts; Task cards remain
  in the transcript (spec Q4). Screenshots in `checkpoint-1-artifacts/`.
- Decision: the codex folded review item keeps the entered frame's `name` and a stable `Review`
  title across its lifecycle, so the dock row does not rename itself on completion.
- Decision: Tasks-table SHAs are stamped by the FOLLOWING step's commit — a commit cannot contain
  its own post-amend SHA. `Status` is always correct in its own commit; only `Commit` trails by one.

## 2026-07-21T10:48:00Z — final gate passed
- Steps 1.1 … 3.1 complete. typecheck / npm test (2995) / test:unit / build / test:package all green.
- `npm run test:e2e` reports failed on this branch AND identically on origin/main (7 failures,
  same specs, none touched here) — proven by building and running the suite in a clean
  merge-base worktree. Passed count differs by exactly +3: this branch's new spec.
- PR opened: https://github.com/open-mercato/cezar/pull/550

## 2026-07-21T11:00:00Z — adversarial review round 1 (subagent, opus)
- 4 major + 6 minor findings. All actioned in `73f15c7`; see PLAN Risks and the PR comment.
- Notable: the reviewer argued the Step 3.1 opencode "hardening" made things WORSE (a fabricated
  `completed` for a subtask that may still be running, while the real misattribution is
  pre-existing). Agreed and REVERTED it — an honest stuck row beats a false success.
- Notable: the codex review latch survived turn end, so an interrupted review left a permanently
  `running` task item and the dock would mount forever on a finished run. Fixed.
- Notable: anchoring on the newest turn alone dropped still-running agents once a later turn
  spawned another Task — the literal spec rule defeated its own stated Q6 intent. The collector
  now unions unsettled earlier roots with the anchor turn's.
- Gate re-run after fixes: 3007 tests green; dock e2e 3/3.
- Label note: `gh pr edit --add-label` exited 0 without applying anything; labels were applied
  via the REST endpoint and read back to confirm (known gh/Projects-classic deprecation path).

## 2026-07-21T11:07:00Z — adversarial review round 2 dispatched
- Re-reviewing the fix batch itself, because fix batches are where new defects enter.

## 2026-07-21T11:05:00Z — external om-auto-review-pr: CHANGES REQUESTED
- A concurrent automation reviewed the PR at 11:04:49Z (against `06436c3`, i.e. pre-fix) and
  found 5 majors + 6 minors. M1/M2/M4 were already fixed in `73f15c7` a minute later; M3 was
  the opencode change I had already reverted.
- Genuinely NEW from that review: **M5** — a terminal run never settles its in-flight agents, so
  reopening a cancelled fan-out pulses `Agents · 0/1` above a dead transcript forever. Fixed.
- Also new: m2 (`aria-describedby={undefined}` suppressed the sheet's description) and m6
  (`findSubagent` structurally could not carry `activity`). Both fixed.
- An `om-auto-qa-pr` run posted ✅ PASS then a correction: its PASS covers only the happy path
  and is explicitly NOT a QA sign-off; `needs-qa` stands and no `qa-approved` was applied.

## 2026-07-21T11:13:00Z — adversarial review round 2: my own fix batch was defective
- Round 2 (re-review of `73f15c7`) confirmed 7 of 10 fixes clean but found the MAJOR-4 fix
  introduced TWO new majors:
  1. carrying only *unsettled* earlier items made a row vanish the instant it settled — the
     odometer counted DOWN (3 → 2 → 1) and could never reach N/N; a failed agent lost its glyph.
  2. the lookback was unbounded, so one stranded agent (which the opencode revert guarantees is
     possible) would inject itself into every later fan-out and pin the dock open for the run.
- Fixed in `99c2fb1`: carry-over is turn-granular and bounded by the last fully-settled fan-out.
- This is the third time in this repo that a fix batch introduced defects a later pass caught.
  Re-reviewing every batch is not optional.
- Gate after the batch: 3017 tests green; dock e2e 3/3.
- Follow-up filed: #551 (opencode single-slot subtask attribution).

## 2026-07-21T11:16:00Z — adversarial review round 3 dispatched
- Verifying the round-2 carry-over rewrite before flipping the pipeline label.

## 2026-07-21T11:25:00Z — run complete
- Round 3 confirmed both round-2 majors genuinely fixed, and found one more that mattered:
  `runIsTerminal` enumerated done/failed/cancelled and MISSED `review` — the status this
  pipeline's runs normally end on — so the "pulses forever" symptom was still live on the most
  common path. Now derived from `sessionOpen` rather than enumerated. Fixed in `27d446b`.
- Also from round 3: the collapsed head and the row rendered a stalled agent differently; both
  now share `subagentActivityText`. And the `activeSubagent` stalled-skip I added was dead code
  (on a terminal run every agent is settled-or-stalled) — removed rather than left as noise.
- Final state: 3020 tests green, build + package green, new e2e 3/3, design-guardian green.
- PR #550: `Status: complete`, label back to `review`, `in-progress` released, summary posted.
- Follow-up: #551 (opencode single-slot subtask attribution).
- Lesson worth carrying: three of four review passes found defects in the PREVIOUS fix batch.
  Re-reviewing after every batch was what caught them; shipping after round 1 would have landed
  an odometer that counts down and a dock that pulses forever on review-gated runs.
