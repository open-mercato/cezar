# Final gate — host resource telemetry (all 9 Steps done)

**Run:** 2026-09-20 · branch `feat/host-resource-telemetry` · PR #1036 (draft at gate time)
**Logs:** `final-gate-artifacts/gate-final.log`, `final-gate-artifacts/e2e.log`,
`final-gate-artifacts/e2e-flaky-recheck.log`

## `validation.commands`, in order (Node v26.8.1, `env -u CEZ_AGENT_MODELS_LOCKED`)

| Command | Result |
|---------|--------|
| `npm run typecheck` | ✅ pass (contract, client, server, web) |
| `npm test` | ⚠️ exit 1 with **558 failed / 6751 passed (7309)** — the SAME failure set as untouched `origin/main`: the same 30 failing files were re-run on `main` (558 failed / 319 passed) and on this branch (558 failed / 319 passed), per-file and per-test-name identical. The pre-existing cause is Node v26's experimental global `localStorage` shadowing jsdom's for the web suites plus environment-sensitive path cases — unchanged by this PR. |
| `npm run test:unit` | ✅ pass |
| `npm run build` | ✅ pass (`check:pack ok — 537 files, 88 under web/dist`) |
| `npm run test:package` | ✅ 16/16 pass |

Regression found BY this gate (and fixed): `health-topic.test.ts` pinned "the app registers exactly
one topic"; the second topic (`host`) made that assertion false while health's own guarantee was
untouched. Step 2.4 restates the pin (health registered exactly once) and keeps `host` covered.
After the fix the failing set above is byte-identical to `main`.

## Integration suite (`.ai/scripts/e2e.sh` → agent-browser + real server)

`TEST_E2E_STATUS=failed`: 27 failed / 192 passed / 6 skipped (36 files) on this branch. This is
**not green on `origin/main` either, in this container**: the same 14 failing files were run on
untouched `main` and failed 22 / passed 82 — and re-running the four files that failed here but
passed there (`progressive-history`, `queued-stack`, `repo-git`, `skills-update`) produced **4
failures on BOTH branches** under identical conditions (25 s browser wait timeouts, distribution
shifting run to run). Read as: environment-level flakiness in this shared container, not a signal
about this change; the specs touching this change's surface are covered by the dedicated browser
pass below.

## Design-system pass

`packages/web/src/design-guardian.test.ts` ✅ 8/8 (no raw hex/amber text/off-token colour in the
card; the CPU thresholds use `--pending` as a fill and `--pending-strong` only as ink).

## UI verification (the change's actual surface)

`om-auto-qa-pr` browser pass: settings → Resources driven in agent-browser against the built app
(`CEZ_DRY_RUN=1`, descriptor `.ai/qa/test-env.json`), screenshots attached to PR #1036 —
`checkpoint-2-checks.md` records the scenario and outcome.
