# Checkpoint 2 — Phases 2 & 3 (editor + Settings UI)

Covers Steps 2.1, 2.2, 3.2, 3.3, 3.4, 3.1 (`2e5334b`..`c1933bc`).

Touched areas: `web/app/src/lib/highlighter.ts` (+toml), `web/app/src/components/code-editor.tsx` (new), `web/app/src/api/{types,client,queries}.ts`, `web/app/src/routes/settings/{agent-config-section,mcp-section,registry}.tsx` (+ tests), `web/app/src/routes.test.tsx`.

## Checks

| Check | Result |
|-------|--------|
| `npm run typecheck` (server + web) | ✅ pass |
| `npm test` (vitest — server + cockpit) | ✅ 121 files, 1972 tests pass |
| New/updated UI tests: highlighter (+toml), code-editor (7), agent-config-section (3), mcp-section (2), settings.test (registry), routes.test (mcp now routed) | ✅ pass |

Build + package deferred to the final gate.

## UI verification

The Settings sections and editor are covered by jsdom component tests (grouping, precedence strings, read-only hosted render, save round-trip, MCP filter, read-only ~/.claude.json listing). The **one property jsdom cannot assert** — the overlay editor's pixel-exact caret/scroll alignment between the `<textarea>` and the `<pre>` — is deliberately deferred to the final gate's `npm run test:e2e` pass (spec #404 §Editor), plus a manual QA pass in the PR. No dev-server browser run at this checkpoint: the alignment check needs the built app and is batched into the final gate rather than run twice.

## Notes

- The branch is based on `origin/main`, whose settings registry has no `skills` section (that work lives unmerged in the user's local tree). The feature adds `agent-config` and unhides `mcp` against the `origin/main` shape; no conflict with that local work is expected, but flag at review.
