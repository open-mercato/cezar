# Handoff — `feat/multi-modal`

For the next model picking this up. Branch is pushed to `fork/feat/multi-modal`, currently
`d768f071`, 46 commits ahead of `origin/main` (`185c68a7`, v0.10.0), 0 behind. 215 files,
+37.7k/−583.

## What the branch is

The **multi-model harness**: one agent writes the code, different agents on different models
from different providers decide whether it is any good, and nothing reaches a human that has
not survived a real validation gate and an independent review council. Nobody grades their own
homework, nothing commits or pushes.

Three parties, three non-overlapping jobs:

| Party | Owns | Where |
| --- | --- | --- |
| cezar | control flow | `packages/cezar/src/harness/driver.ts` — a phase state machine in `RunManager` |
| skills | judgment | vendored `cez-*` playbooks, sha256-pinned out of the model-writable worktree at preflight |
| `harness.mjs` | mechanics | `vendor/skills/cez-harness/scripts/harness.mjs`, run as a sealed child |

Three roles bound to `runner/model` at submission: orchestrator, implementer, 2–5 reviewers
spanning ≥2 provider families. Pipeline is
`preflight → capture → spec → spec-council → implement → validate → council → fix-loop → stage → review gate`.
Stage-only is mechanically enforced (sandbox hooks, git ref/reflog integrity, git-derived
staging allowlist, server routes that 409 push/PR until the ledger proves staging). Rides the
`multiModel` flag in `.ai/cezar/config.json`, off by default.

Full narrative: `docs/multi-model-harness.md` (untracked — decide whether it ships).
Design records: `.ai/specs/2026-07-23-harness-orchestration.md` and its follow-ups.

## What this session added on top

Three code changes and one eval. Everything else on the branch predates this session.

**1. `ea5aa467` — merge of main (0.10.0).** Ten conflicts, all where main's runner-teardown
fixes (#844/#857, #858/#867) landed on code this branch had rewritten around
`terminateAgentProcessTree`. Resolution keeps the branch's tree-wide teardown and adopts
main's liveness predicate: every watchdog gates on `trackChildExit`, never
`ChildProcess.killed`; SIGKILL escalation stays inside `terminateAgentProcessTree`, which asks
whether the process GROUP is alive rather than whether the leader exited. Main's fake-child
escalation tests asserted `child.kill()` sequences the group teardown does not produce — and
their made-up pids would have had `process.kill(-pid)` reach a real process group on the host
— so they were rewritten against the same seam. `AGENT_PROTOCOL.md` states the tree-wide rule
beside main's `killed` paragraph.

**2. `949f9039` — OpenCode reviewers are seatable.** The stage-only refusal covered every
role. It is correct for orchestrator and implementer (agent sessions that write to the
worktree; cezar has a seam for claude and codex, none for OpenCode) and wrong for reviewers —
`reviewer-binding.ts` exists to translate a picker-chosen `opencode/<model>` reviewer into one
structured gateway call, no session and no config file, and the blanket guard ran first.
`opencodeSeatingError` now covers all three call sites; a reviewer is refused only when
`synthesizeReviewerBinding` returns null. The composer half was louder: it offered OpenCode
for every role, DEFAULTED the orchestrator to `opencode/claude-fable-5`, probed it green, and
enabled Start on a lineup the server always 409'd. Session roles now draw from
`sessionRoleOptions`, and `harnessRolesIssue` explains a stale draft inline.

**3. `6d71a086` — synthesized council config.** `validateConfig` in `harness.mjs` refuses a
council without `agentHarness.version === 1` and `delivery.mode === 'stage-only'`. The driver
synthesizes that config when the repo has none — the case its own comment calls "the ordinary
cezar project" — but wrote only `models` and `profiles`, so every zero-config council died on
`agentHarness.version must be 1`. Both keys are cezar invariants, so the driver states them,
in the synthesized config only. Mutation-checked. This is almost certainly what the 2026-08-06
eval recorded as "my config error".

**4. The eval** — `.ai/specs/2026-08-23-multi-model-eval.md`, protocol and results.

## Eval result (the PR's evidence)

5 tasks × 2 arms on a `create-mercato-app` scaffold. Single = `quick-task` claude/haiku.
Multi = `harness-implement-feature`, orchestrator claude/haiku(low), implementer
codex/gpt-5.6-luna(medium), reviewers claude/haiku + codex/gpt-5.6-luna +
opencode/muse-spark-1.2-contributor-free — every seat from a CLI login or a free tier, **no
`agentHarness` config at all**.

| | Single | Multi-model |
| --- | --- | --- |
| Delivered to its own worktree | 2 / 5 | **5 / 5** |
| Tests written | 4 / 5 | 5 / 5 |
| Gate 4/4, salvage credited | 4 / 5 | **5 / 5** |
| Cost | $4.54 | $13.33 |
| Wall clock | 53m | 343m |
| Reviewer completions | — | **90 / 90**, 401 findings |

The difference is **reliability, not capability** — the single arm produced good code on 3 of
5 and more tests than the harness on one, but put the work in the wrong tree 3 times, shipped
a red gate once, and reported success every time. The single arm was re-run to match the
harness on settings-source hygiene and location contract (both unrelated to single-vs-multi);
containment went 0/5 → 2/5 and no further. Instruction does not contain a single agent.

## Validate before opening the PR

Run in order; all were green at `d768f071` except where noted.

```bash
npm run typecheck    # clean
npm test             # 6648 passing; auto-resume.test.ts has a known ENOTEMPTY temp-dir flake
npm run test:unit    # 35 passing
npm run build        # NOT run this session — do it
npm run test:package # NOT run this session — needs a completed build
```

Then, specifically for this branch:

1. **`npm run build` and `npm run test:package`.** Neither was exercised. The branch adds
   `scripts/vendor-skills.mjs` and a `vendor/skills/` tree that the pack gate has never seen.
2. **E2E** (`npm run test:e2e`) — never run this session. The branch adds whole new routes
   (`task-harness/`, `new-task-harness.tsx`).
3. **The composer's OpenCode split, by hand.** Orchestrator and implementer pickers must not
   offer OpenCode; the reviewer picker must. A saved preset carrying an OpenCode session role
   must show the inline error rather than 409 on Start.
4. **A real zero-config harness run** in a repo with no `.ai/agentic.config.json`, to confirm
   `6d71a086` end to end. The eval covered it, but on one app.
5. **CHANGELOG.** `# Unreleased` has no entry for any of this. Required before the PR.
6. **Decide on `docs/multi-model-harness.md` + `.html`.** Both untracked. The `.md` is the
   readable overview and was corrected this session (OpenCode reviewers, three transports).
   The `.html` looks generated — the branch has a standing policy of not committing generated
   artifacts (`24e639ef`, `834caa47`).

## Known open items

- **Probe and council disagree on transport for a gateway reviewer.** Preflight verifies an
  `opencode/<model>` ref by spawning `opencode serve` under a 45 s budget; the council reaches
  the same model as a structured call with a 10-minute budget. So preflight is *stricter* than
  execution and can refuse a run that would have completed. Seen once live (Muse Spark failed
  a cold probe, passed 60 s later, then completed 30/30 council rounds). The bare
  `This operation was aborted` error text is also worse than the codex path's. `probe.ts`
  already documents the hazard.
- **Ordinary runs have no location contract**, and a run's worktree is nested inside the
  checkout with a `.git` FILE, so repo-root heuristics resolve to the parent. `driver.ts`
  works around this for harness phases by naming the root explicitly; `quick-task` does not.
  Adding the same sentence to `HANDOFF_ONLY_INSTRUCTIONS` is the obvious move, but a matched
  eval arm showed it only takes containment from 0/5 to 2/5 — it is not a fix on its own.
  Do NOT root `CEZ_HANDOFF_FILE` in the worktree: the external location is deliberate and
  server-owned, and moving it breaks persistence and consumers.
- **An empty ordinary run settles as `done`.** No check that anything was produced. A blanket
  refusal is wrong (empty can be legitimate); a diagnostic or a distinct outcome is the better
  shape.
- **No agent-account picker in the Multi-model composer.** `new-task.tsx` has one; harness
  runs fall back to the project default per backend, so a two-account machine cannot say which
  account a role bills.
- **`ResolveConflictsButton` on a harness run.** Main's conflict chip offers "Resolve
  conflicts" on tasks parked at review — the harness's normal end state — and it resumes the
  last phase session outside the driver and outside the stage-only sandbox. Unexamined.

## Repo conventions that bit this session

- Run vitest through `npm test`, never `npx vitest` (AGENTS.md).
- `npm run typecheck` needs `build:server` first; the web package types against
  `packages/cezar/dist`, so a stale dist produces phantom errors.
- No narration comments in new code; keep spec/issue/run citations.
- Eval sandbox lives outside this repo at `~/GIT/Open Mercato/om-eval-sandboxes/`, on branch
  `eval-baseline-2026-08-23` (`e161420`). `eval-app/.ai/cezar/config.json` has
  `multiModel: true` — this repo's copy has it too and it is gitignored, so a fresh clone
  will not show the Multi-model tab until it is set.
