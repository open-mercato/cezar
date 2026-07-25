# Checkpoint 1 — Phase 1 complete (Steps 1.1 … 1.4)

**Recorded:** 2026-07-21T10:22:30Z
**Steps covered:** 1.1, 1.2, 1.3, 1.4
**Commit range:** `bd205e4` … `e021935`

## Touched areas

- Cockpit task-thread: new collector (`subagent-dock.ts`), new dock component
  (`agents-dock.tsx`), one mount point in `task-thread.tsx`.
- Codex mapper (`src/core/codex-ui-mapper.ts`) + its golden fixture expectation.
- Dry-run mock (`scripts/mock-claude.mjs`) — new `mock:subagents` trigger.
- `AGENT_PROTOCOL.md` — the sub-agent task-item parity row now states the one-item rule.

## Checks

| Check | Result | Notes |
|---|---|---|
| `npm run typecheck` | **pass** | server + web, clean |
| `npm test` (vitest, server + cockpit) | **pass** | 176 files, 2975 tests |
| `npm run test:unit` (node:test) | **pass** | 30 tests |
| `design-guardian.test.ts` | **pass** | new dock uses semantic tokens only; no `text-pending`, no raw hex, no `dark:` variant |
| Golden fixture `codex/review-mode` | **pass** | updated to one task item, running→completed |
| Browser UI verification | **pass** | see below |

`npm run build` / `npm run test:package` are deliberately deferred to the final gate
(step 7) — they are slow and nothing in this window changes packaging.

## Browser UI verification

The dock is new UI, so it was driven in a real Chrome through the `agent-browser`
provider rather than trusted to unit tests (the unit gate does not boot the app).

- Env: `.ai/scripts/test-env-up.sh` → `TEST_ENV_STATUS=running` on
  `http://127.0.0.1:50261`, `CEZ_DRY_RUN=1`, `BROWSER_INSTALLED=1`.
- Scenario: new task with the prompt `mock:subagents — show the grouped agents dock`,
  runner claude (mocked).
- Observed dock text, read from the live DOM:

  ```
  Agents · 2/2
  Audit the auth flow   GENERAL-PURPOSE   Read src/middleware.ts    2 tools
  Review the store layer CODE-REVIEWER    Ran npm test -- runs/store 1 tool
  ```

- Collapsed head after toggling: `Agents · 2/2 — Read src/middleware.ts`.
- The two `Task` cards are still present in the transcript above the dock — spec Q4
  (additive; the thread stays the record) confirmed visually, not just asserted.

Artifacts:

- `checkpoint-1-artifacts/screenshot-agents-dock-expanded.png` — dock expanded over the
  live thread, both agents completed, type badges and tool counts visible.
- `checkpoint-1-artifacts/screenshot-agents-dock-collapsed.png` — collapsed one-line state.

## Decisions in this window

- **Codex folded item keeps the entered frame's `name`** (`enteredReviewMode`) and takes a
  stable title `Review` across the lifecycle. Rationale: the UI item genuinely was
  introduced by that frame, and a row that renames itself on completion would read as a
  different agent. The unpaired-exit fallback keeps its own id and name.
- **Tasks-table SHAs are stamped by the FOLLOWING step's commit.** Recording a commit's own
  short SHA inside that same commit is self-referential — `git commit --amend` changes the
  SHA it just wrote. Each row therefore lands `pending` and is corrected one commit later;
  the `Status` column (the only thing `om-auto-continue-pr-loop` parses for resume) is always
  correct in its own commit.

## Result

**Checkpoint 1 passed.** Phase 1 is shippable on its own: the grouped live display works
across the protocol seam, with codex's review mode now presenting as one agent instead of two.
