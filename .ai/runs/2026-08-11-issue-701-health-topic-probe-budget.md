# Execution plan — answer @patzick's review: drive `health-topic.test.ts` time through vitest's fake-timer API (adopted from PR #733)

**Origin:** adopted — reconstructed by `om-auto-continue-pr` on 2026-08-11 because PR #733 carried no execution plan (it predates the `Tracking plan:` convention on this branch).
**PR:** #733 · **Branch:** `fix/issue-701-health-topic-probe-budget` · **Base:** `main`
**Author:** @wojciechszyjka — this plan interprets the remaining review feedback; correct it by editing this file or commenting on the PR.

## 🎯 Goal

Land @patzick's `changes-requested` ask: stop steering `health-topic.test.ts` with raw `vi.spyOn(Date, 'now')` mocks and drive its clock through vitest's fake-timer API instead, then state plainly whether the probe-budget change this PR opened with is still needed.

## Scope

- `packages/cezar/src/server/health-topic.test.ts` — the clock-control mechanism in all five cases that move time, plus the suite's setup/teardown.
- A written answer, on the PR, to the second half of the review ("not sure if this one will still be needed then").

## Non-goals

- **No production code.** `server.ts`'s health cache, its TTL, and its staleness ceiling are the subject under test and stay untouched; this PR has been test-only since it opened and stays that way.
- **No mocking of the probes themselves.** Stubbing `detectEnvironment` / `getRepoInfo` would make the suite fast, but it would also stop exercising the real snapshot path these cases were written against. If that is wanted it belongs in its own PR, not here.
- **Not the rest of #701.** The other ~26 load-sensitive suites (`git-worktree`, `run-lease`, `autosave-*`, …) stay out of scope; they fail identically on an untouched `main` and were measured as such on 2026-08-10.

## Evidence

| Conclusion | Drawn from | Confidence |
|---|---|---|
| The one remaining blocker is the clock-mocking mechanism, not the budgets | @patzick's `CHANGES_REQUESTED` review, 2026-08-10T18:25Z: *"this test should be rewritten using fake timers from vitest … mocking Date now doesn't look proper"* | high |
| Everything else on this PR is already accepted | @pkarw's `APPROVED` review of 2026-07-30 (all five validation commands green) and the `om-auto-fix-pr` run of 2026-08-10 that resolved the conflict against `main` and re-verified CI | high |
| The suite steers time in five places | `vi.spyOn(Date, 'now').mockReturnValue(...)` at the staleness-ceiling, stale-window, publish-on-change, unsubscribe, and in-flight-dedupe cases | high |
| Faking timers cannot remove the need for the wait budgets | The cache's clock arithmetic is `Date.now()`-based, but `settle()` waits on a fire-and-forget snapshot that spawns `git` and agent-CLI child processes — real subprocess latency, which no timer mock shortens | high |
| Only `Date` may be faked, not the timer functions | The code under test `await`s real child processes and real fs; faking `setTimeout`/`setInterval`/`nextTick` would leave nothing to advance the clock while those awaits are pending, and the suite would deadlock | medium |

## Assumptions

- **`vi.useFakeTimers({ toFake: ['Date'] })` is what "use fake timers" means for a suite that spawns real processes.** It is the same `vi.useFakeTimers` / `vi.setSystemTime` API the review linked; the `toFake` narrowing is what makes it applicable here. If @patzick wants the timer functions faked too, that requires stubbing the probes first and is a different PR.
- **Pinning the clock right after `settle()` is an improvement worth taking while here.** It removes a second latent flake in the same file: the "answers instantly from cache inside the TTL" case currently passes only because `settle()` happened to finish inside the 5 s TTL, which is the very assumption this PR set out to stop relying on.
- **The budgets stay.** If the answer should instead be "close this PR", that is @patzick's call and the PR comment asks for it explicitly.

## Risks

- `vi.waitFor` nudges an installed fake clock by one poll interval per poll. With only `Date` faked that advances the simulated clock at roughly real-time pace during a wait — bounded, and analysed against the 60 s staleness ceiling in the test's own comments, but it is the one non-obvious interaction of this change.
- Freezing `Date` for the whole suite could surface an unrelated dependency on a moving clock (the run store, the topic's publish interval). The focused suite plus the full validation gate are what catch that.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Already landed on this PR (reconstructed)

- [x] 1.1 Give both `vi.waitFor` call sites an explicit 30 s probe budget and the nine async cases a 60 s test ceiling, replacing vitest's unspendable 1 s / 5 s defaults — d58f0dc0
- [x] 1.2 Merge `origin/main` and resolve the three-way conflict in `health-topic.test.ts`, keeping `main`'s stronger assertions over the branch's weaker ones — e2aa2c9d

### Phase 2: Address @patzick's review — fake timers instead of `Date.now` spies

- [x] 2.1 Install a `Date`-only fake clock for the suite (`vi.useFakeTimers({ toFake: ['Date'] })` / `vi.useRealTimers()`), and document why the timer functions are deliberately left real — 77e54c6d
- [x] 2.2 Replace every `vi.spyOn(Date, 'now').mockReturnValue(...)` with `vi.setSystemTime(...)`, pinning each case's clock to an explicit offset from a post-`settle()` baseline instead of an incidental `Date.now()` reading — 77e54c6d
- [x] 2.3 Re-run the focused suite and confirm the ten cases still assert the same cache policy, then run the full configured validation gate — 77e54c6d

  All five configured commands green on `77e54c6d`: `typecheck` ✅, `build` ✅ (`check:pack ok — 462 files`), `test:unit` ✅ 35 pass / 1 skipped, `test:package` ✅ 12 pass, `npm test` ✅ **310/310 files, 5651/5651 tests**. The full suite was run twice: once on a saturated machine (27 files red, 410 s) and once on a quiet one (0 red, 88 s) — the same tree, which is this PR's own argument about #701 reproduced by accident.

### Phase 3: Close the review loop

- [x] 3.1 Answer the second half of @patzick's review on the PR — whether the probe budgets are still needed once the clock is faked — and update the PR body's What Changed / Tests sections — answered in the re-review comment of 2026-08-11

  **Answer: yes, and the two changes are orthogonal.** The budgets guard `settle()`, which waits on a child process finishing, not on a timer firing. `vi.setSystemTime` moves the cache's "now" two hours in a microsecond but cannot make `git` answer sooner. Making the budgets genuinely unnecessary means stubbing `detectEnvironment` / `getRepoInfo` so nothing is spawned — a real improvement, and its own PR.

- [x] 3.2 Run `om-auto-review-pr 733 --autofix`, post the resume summary, and normalize labels (clear `changes-requested` only if the review clears it) — re-review submitted 2026-08-11

  No blocker, major or minor findings; one nit (`vi.restoreAllMocks()` now vestigial) declined with a reason, so the autofix loop had nothing actionable to do. Verified beyond the gate with two mutation probes against `server.ts` (ceiling disabled → 2 cases fail in 315 ms; stale revalidation awaited → 1 case fails in 622 ms), both reverted, tree clean. Pipeline label moved `changes-requested` → `review`. **@patzick's review is not dismissed — only he can do that.**

### Phase 4: Is this coverage still needed on today's `main`? (resume of 2026-08-13)

> Added by `om-auto-continue-pr` on 2026-08-13. @patzick's review closed with *"also not sure if this one will still be needed then"*. Phase 3.1 answered the narrow reading (do the **budgets** survive the fake-timer rewrite). This phase answers the broad one: does `health-topic.test.ts` still need this fix **on `main` as it stands today**, or has the PR been overtaken and should be closed?

- [x] 4.1 Establish whether the subject under test is still live on `main` and whether anyone else fixed the flake in the meantime — 3c09046e

  **Still live, and nobody fixed it.** On `main` at `f1c186ce`: `health-topic.test.ts` is byte-identical to this branch's merge-base `60650171` (`git diff 60650171 origin/main -- <file>` is empty), so no other PR touched the flake. The cache policy it guards is byte-identical too — `server.ts` changed by +168/−44 since the merge-base, but its hunks skip from `@@ -1069` to `@@ -1603`, and the whole health block (`HEALTH_TTL_MS`, `HEALTH_MAX_STALE_MS`, `refreshHealth`, `readHealth`, the boot pre-warm, the publisher interval) lives at 1427–1600. The topic still has a live consumer: `packages/web/src/api/queries.ts` keeps the one session-long `health` subscription — #688 disabled the health websocket only in *remote* mode, on the web side.

  **The probe sweep the test waits on got heavier, not lighter.** #470 (the `pi` runner) added a sixth probe to `detectEnvironment()` — `pi --version`, a child process with a 10 s exec timeout — so every health snapshot now spawns one more process than when this PR opened.

- [x] 4.2 A/B the focused suite on today's `main` against this branch merged with today's `main` — f93510ac

  Same machine, same minute, load average ~40 on 11 cores:

  | Tree | `npx vitest run --project server packages/cezar/src/server/health-topic.test.ts` |
  |---|---|
  | plain `origin/main` `f1c186ce` | ❌ **2 failed / 8 passed** (42.4 s) — `Test timed out in 5000ms` in the stale-window revalidation case and the publish-on-change case |
  | this branch merged with the same `main` (`f93510ac`) | ✅ **10 passed** (49.2 s) |

- [x] 4.3 Re-run the mutation probe on the merged head, so "it passes" is not confused with "it still catches regressions" — f93510ac

  Staleness ceiling disabled in `server.ts` (`if (age > HEALTH_MAX_STALE_MS) return refreshHealth()` removed): **2 cases fail by `AssertionError` in 2268 ms / 1837 ms** — `expected 'claude' to be 'codex'` and `expected [] to have a length of 1`. Failure by assertion, not by timeout: the fake clock still reaches the server's `Date.now()`, and the generous budgets do not convert a real regression into a 30 s hang. Probe reverted, tree verified clean.

- [x] 4.4 Merge `origin/main`, re-run the configured validation gate, and answer @patzick explicitly on the PR — f93510ac

  `origin/main` `f1c186ce` merged cleanly (no conflict). Gate on the merged head: `typecheck` ✅, `test:unit` ✅, `build` ✅, `test:package` ✅, focused `health-topic` ✅ 10/10.

  `npm test` on the merged head: **39 files / 186 tests red out of 319 / 5932**, in 538 s, on a machine sitting at load average 26–42 for the whole run. Reported as-is rather than as green — but `health-topic.test.ts` is **not among the 39**, and the 39 are the known #701 family this PR does not claim to fix (`git-worktree`, `run-lease`, `run-isolation`, `autosave-*`, `worktrees-api`, `pasted-attachments`, …), all failing on 5 s / 20 s timeouts in suites that spawn real `git` and child processes. The same command on this same tree came back 0 red in 88 s on a quiet machine two days ago. GitHub Actions on the pushed head is the authoritative signal.

## Verdict of Phase 4

**Keep the PR — the coverage is still needed and still unfixed on today's `main`.** The answer to @patzick's *"not sure if this one will still be needed"* is: the file it fixes still fails on `main` (two 5 s timeouts, reproduced 2026-08-13), the policy it guards is unchanged, and the sweep it waits on gained a probe. Closing it would leave `main` with a suite that goes red under load and catches nothing extra when it does.
