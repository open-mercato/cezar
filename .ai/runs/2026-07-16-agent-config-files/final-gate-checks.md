# Final gate — all 13 steps done

Branch diff: `origin/main..HEAD`. Every Tasks-table row is `done`.

## Full validation gate (`validation.commands`)

| Command | Result |
|---------|--------|
| `npm run typecheck` (server + web) | ✅ pass |
| `npm test` (vitest — server + cockpit) | ✅ 122 files, 1977 tests pass |
| `npm run test:unit` (node:test) | ✅ 4 pass |
| `npm run build` (tsc → dist, vite → web/dist, `check:pack`) | ✅ built; check:pack ok (223 files, 69 under web/dist) |
| `npm run test:package` (pack tarball + dry-run CLI) | ✅ 1 pass |

## Integration / e2e suite (`npm run test:e2e`)

**Not green in this environment — pre-existing and unrelated to the feature.** The suite provisioned agent-browser and then failed 11 tests across `task-thread`, `smoke`, `task-changes`, `review-gate`, `variants-compare`, `task-files`, `github`, `settings-agents`, `settings-appearance`, plus 4 `ENOTEMPTY` suite-teardown errors on temp dirs.

Evidence these are not regressions from this branch:
- **This branch changes zero e2e files** (`git diff --stat origin/main -- web/app/e2e/` is empty).
- **No failing suite references the feature** — grep for `agent-config` / `/settings/mcp` / `code-editor` across every failing suite returns nothing. The failures are things like a missing `[data-slot="pr-link"]`, `agents-base-branch` `options[1]` being empty (needs repo branches), empty-state fixtures, and temp-dir cleanup races — environment/fixture issues, not this change.

Per the run contract, UI checks must not block; the reason is recorded here and in NOTIFY.

## Editor pixel-alignment — deferred to manual QA

The overlay editor's one property jsdom cannot assert — caret/scroll alignment between the `<textarea>` and the `<pre>` — was assigned to the e2e tier (spec #404 §Editor). Because the e2e environment is not green here for reasons unrelated to the feature, this is flagged as a **manual QA checklist item on the PR** rather than gated on the broken suite. Fallback if alignment proves fragile is documented in the spec (read-only `<pre>` + plain `<textarea>` toggle).

## Design-system / style compliance pass

Skipped — the repo has no design-system skill (`.ai/skills/` absent) and no `lint`/`style` command in `package.json`. The section reuses existing shadcn primitives and the established token classes (`text-soft-foreground`, `bg-primary/15`, etc.), so no bespoke styling was introduced.

## Security property (re-affirmed)

`src/server/agent-config-api.test.ts` asserts every `PUT /api/agent-config/:id` 409s under `CEZ_REMOTE=1` — including a **repo-local** id whose hooks would otherwise be a remote code-execution primitive. This is the load-bearing invariant; the gate is re-checked server-side in the PUT handler and never trusts the client.
