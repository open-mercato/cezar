# Checkpoint 1 — Phase 1 complete (Steps 1.1–1.5)

**Fired:** 2026-09-20T00:17:00Z · five consecutive Steps landed · branch `feat/host-resource-telemetry`

## Targeted validation

| Command | Result |
|---------|--------|
| `npx vitest run packages/cezar/src/core/host-usage.test.ts packages/cezar/src/server/host-topic.test.ts packages/cezar/src/server/workspace-api.test.ts packages/cezar/src/server/route-parity.test.ts packages/cezar/src/server/bc-route-inventory.test.ts` | **5 files, 87 tests passed** |
| `npm run typecheck:server` | pass (`tsc --noEmit -p tsconfig.test.json`) |
| `npm run typecheck:contract` | pass (run in Step 1.1) |

Guard check: the staleness tests were verified to FAIL with `HOST_SAMPLE_STALE_MS` neutered to
`Number.MAX_SAFE_INTEGER` (2 red) and pass with the real bound — the regression guard is real, not
a test that is green either way.

## UI check

Not applicable at this checkpoint: Steps 1.1–1.5 are server-only (contract, sampler, route,
topic). No screen changed, so no browser session or screenshot was taken; the card arrives in
Phase 2 and the browser pass runs at checkpoint 2 / final gate.

## What the five commits establish

- `hostUsageSchema` is the single wire shape for both transports, with "absent means the OS does
  not expose it" pinned in both directions.
- The sampler answers only from a bounded CPU-delta window (≤ 6 s), omits swap on non-Linux or a
  swapless machine, omits load on Windows, and starts its timer only between 0→1 and 1→0.
- `GET /api/v1/workspace/host-usage` exists, is workspace-only (parity suite) and is inventoried
  (§2 drift guard).
- The `host` topic registers trusted-only beside `health`, publishes one sample per 2 s tick
  while subscribed, and publishes nothing once the last subscriber leaves.
