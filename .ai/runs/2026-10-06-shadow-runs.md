# Shadow runs: real agents, zero outward side effects

**Brief:** let a task do real work on a real repository while every outward side effect - `git
push`, `gh` writes - is captured as an intent a human promotes, so a team can trial agents and
automations on its production repository with zero blast radius.
**Engine:** om-auto-create-pr, run by hand: the om-* skills are not installed on this machine, so
each stage followed its contract in `SDLC.md`, `CODE_REVIEW.md` and `.ai/trackers/github.md`
(triage -> implement -> om-code-review -> validation gate -> om-open-pr).
**Branch:** `feat/shadow-runs`, pushed to the fork `zawstudio/cezar`: the author has no push or
triage permission on `open-mercato/cezar`, so the PR is cross-repository and its labels are
proposed in the body rather than applied.
**Spec:** `.ai/specs/2026-10-06-shadow-runs.md`

## Goal

A worktree already isolates what an agent does to files; make it possible to isolate what it does
to the world, without a sandbox, a daemon or a setting - and prove the isolation holds before the
run starts.

## Scope

- The boundary: git's own `pushInsteadOf` injected through `GIT_CONFIG_*` (verified by asking git
  where every remote now pushes, refusing the run otherwise), a recording `gh` shim first on PATH,
  tracker credentials withheld.
- The ledger and its trust model: append-only intents written by the shim and the shadow remotes'
  hooks, never trusted for a verdict; decisions written by the server alone.
- Promotion: one click-class intent at a time, `execFile` without a shell, never `--force`,
  manual-class intents handed back as commands.
- The three routes, the contract, and the run / dispatch / variants / automation / check-step
  wiring.

**Non-goals:**

- The cockpit surface (composer toggle, Shadow tab, chips): Phase 2 of the spec.
- Stripping forge tokens from shadow runs (spec Q4) and `glab` rows: Phase 3.
- A sandbox. The spec's "Not captured" section is part of the deliverable, not a gap in it.

## Approach

Arm on every spawn rather than once (the #811 lesson: a guarantee cached on one construction path
lapses on the other), fail closed everywhere a reading is uncertain (an unknown gh command, a
non-canonical argv, an unprovable redirect), and keep every verdict server-derived from raw argv
and refs, because the ledger is written by processes the agent controls.

## Risks

- **Seatbelt, not sandbox.** A process that clears its env, an absolute path to the real gh, raw
  HTTP with an env token, PATH reordering inside an agent's own tool shell and other publishing
  CLIs are not caught in Phase 1. Stated in the spec; check steps ARE covered by a wrapper that
  re-asserts the shim after login profiles run.
- **The validation gate cannot go green on the author's machine.** Windows 11: `npm test` reds
  ~106 files and `npm run test:unit` fails on `/bin/sh` - identically on the untouched merge base
  (stash comparison below), so CI on Linux is the gate of record for this PR. Fork CI does not
  run (account billing), so 5.5 and 5.6 were gated in a `node:24-bookworm` container (`--init`,
  non-root, TMPDIR inside the checkout as in the review run): typecheck, `npm test` (9454 passed;
  one of three full runs hit the `auto-resume` teardown flake that main shows at the same rate),
  `test:unit` (42), `build` and `test:package` green.
- **No live agent run.** The boundary sits below the agent (git and PATH), so the backend should
  not matter; it was exercised with real git, real hooks and the real shim entry, not with a live
  Claude or Codex session.

## Progress

PR: #1314

> Convention: `- [ ]` pending, `- [x]` done. Append ` - <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Establish the facts

- [x] 1.1 Sweep the code, `.ai/specs/`, and all 772 PRs and 540 issues for overlap: none (closest #475, #708, #1031, #1155-#1158, #1028) - 96b3d979
- [x] 1.2 Design and spec (`2026-10-06-shadow-runs.md`) - 96b3d979

### Phase 2: The boundary

- [x] 2.1 gh policy table: fail-closed, canonical argv only, `gh api` by method and body - 822a45ec
- [x] 2.2 Push redirect through `GIT_CONFIG_*`, verified per remote plus a scratch-repo probe - 822a45ec
- [x] 2.3 Shim, ledger (redacted and bounded at write), bounded zod read - 822a45ec
- [x] 2.4 Arming on every spawn; the check-step wrapper; cancel during arming - 822a45ec

### Phase 3: Promotion and API

- [x] 3.1 promote / discard, file references re-derived from argv - 822a45ec
- [x] 3.2 Routes chained into `v1`, contract, parity tests, BC §2/§3, `.env.example` - 822a45ec
- [x] 3.3 Run, dispatch, variants, automation and open-in-cli wiring - 822a45ec

### Phase 4: Ship

- [x] 4.1 om-code-review pass: 1 blocker, 4 majors, 8 minors and nits, all addressed before the first push - 822a45ec
- [x] 4.2 Two regression tests proved red without their fix (hook accepting pushes; skip-the-flag argv reading) - 822a45ec
- [x] 4.3 Validation gate: typecheck green; 158 shadow and guard tests green; full suites compared against the untouched merge base - 822a45ec
- [x] 4.4 Draft PR, proposed labels, CLA signed by the author, review loop - 822a45ec

### Phase 5: Review loop

- [x] 5.1 Review blocker: the no-repository case stays outside every repository, wherever the temp dir is - f47bd87d
- [x] 5.2 Ledger paths built from the stored run id, not the URL param - d19bc0f1
- [x] 5.3 Graph system nodes that act on the world are refused in a shadow run - 22910e40
- [x] 5.4 A shadow check step sees the run context and the shadow overrides - f6c61eb8
- [x] 5.5 The gate in the review environment: git discovery stops at the temp dir for the whole suite (10 tests red on main there) - 79ca81cb
- [x] 5.6 Second review pass: open-in CLI handoff, protected base branches, gh promotion's working directory, unrunnable scripts, atomic state, loopback API stated - 03cf364e
