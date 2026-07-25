# Final gate — all 11 Steps done

**When:** 2026-07-21T12:14:00Z
**Branch:** `feat/queued-session-prompt-stacking`
**Merged base:** `origin/main` @ `8c22ab9` (main moved during the run — see "Merge" below)

## Full `validation.commands` gate

| Command | Result |
|---|---|
| `npm run typecheck` | ✅ pass (server + web projects) |
| `npm test` | ✅ **3157 passed / 179 files**, 0 failed |
| `npm run test:unit` | ✅ pass, 0 fail |
| `npm run build` | ✅ pass |
| `npm run test:package` | ✅ pass — `check:pack ok, 284 files` |

`CEZ_*` env vars scrubbed before every command: a cezar-launched shell exports
`CEZ_REMOTE` / `CEZ_DRY_RUN` and they leak into the runner's fixtures.

## Integration / E2E suite

`web/app/e2e/queued-stack.e2e.ts` — **5/5 pass** (32 s), re-run after the merge.
Drives a real browser against a live dry-run cezar with `{"maxParallel": 1}` and
a `mock:slow` blocker holding the only slot.

Screenshots in `.ai/qa/artifacts_e2e/`, attached to the PR:
`queued-composer-enabled.png`, `queued-stacked-message.png`, `queued-editing.png`,
`queued-started-with-amended-prompt.png`.

### Pre-existing E2E failures — proven, not assumed

The full `npm run test:e2e` run reports `TEST_E2E_STATUS=failed` with 6 failures
across `settings-bookmarklets`, `settings-appearance`, `settings-skills`,
`github`, and one `task-thread` tab assertion, plus 4 suites skipped.

**None are caused by this branch, and that was verified rather than assumed:** the
worktree was checked out to a detached clean `origin/main`, rebuilt, and the same
specs re-run. The identical 4 fast failures reproduce there with none of this
branch's code present:

```
× tabs point at the routed Session/Changes/Files surfaces …
× the generic launcher bakes the protected /new grammar …
× the legacy /settings/skills?skill=__bm entry point …
× the shell renders the registry sections …
Test Files 3 failed | Tests 4 failed | 25 passed
```

The suite touched by this work (`queued-stack`, `composer`, `task-thread` thread
assertions) passes.

## Merge with a moved main

`origin/main` advanced from `67cdd2f` to `8c22ab9` mid-run, including #524, which
made `UserBubble` render **markdown** — the same component this work extends with
edit/remove affordances. Two conflicts, both resolved to keep **both** changes:

- `thread-items.tsx` — main's `<Markdown breaks>` rendering, `min-w-0`, and the
  dropped `whitespace-pre-wrap`, together with the affordance row and the inline
  editor. The editor deliberately edits the **raw markdown source**, not the
  rendered output.
- `task-thread.tsx` — the `queued` flag alongside main's new sub-agent dock state.

Verified after merging: typecheck clean, 3157 unit tests pass, and the browser E2E
re-run green (so the markdown bubble and the affordances genuinely coexist).

## Design-system / style pass

No dedicated design-system linter exists in this repo (`validation.commands` has
no style command beyond the typecheck/build pair). The new UI reuses existing
tokens and slot conventions only — `bg-muted`, `text-soft-foreground`,
`focus-visible:ring-ring/50`, `data-slot="…"` — and adds no new colors, spacing
values, or components. Light/dark theming and keyboard access verified in the
browser (screenshots are dark theme; the edit/remove controls are real buttons
with `aria-label`s, and Escape cancels the editor).
