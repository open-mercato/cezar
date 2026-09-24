# Execution plan — readable task names in the sidebar quick-list (issue #788, option C)

Issue: <https://github.com/open-mercato/cezar/issues/788> — the maintainer picked **option 3 / C**,
"Structural: de-duplicate the number, let the column breathe". The follow-up comment from
`@patzick` on the issue ("sidebar should be available for drag to resize on desktop, we can have
min-width so user can make it a bit bigger for their needs") confirms the resizable-column half is
wanted, not optional.

## 🎯 Goal

A sidebar quick-list row shows a readable task **name** again. Today a worst-case row spends its
244px of content on a status dot, an unabbreviated `+59514 −12160` diff pair, a `PR ↗` chip and an
unread dot — every one of them `shrink-0` — leaving the title, the only `min-w-0 flex-1` element,
about 68px ≈ 10 characters, five of which are the `775: ` prefix the row *also* shows in its PR
chip. Option C attacks that on both sides: stop rendering the reference number twice, and stop
pretending every desktop wants the same 264px column.

## Scope

Two composable halves, both confined to the cockpit bundle (`packages/web`):

1. **Render-only reference de-duplication.** Strip the `NNN: ` prefix at display time and promote
   the number into a **leading** mono ref chip that is itself the PR/issue link, replacing the
   separate trailing PR chip. Stored titles are untouched — the Tasks table, the page title and
   search keep reading the same `titleSummary`/`title` fields byte-for-byte.
2. **A user-resizable desktop sidebar.** The `md`-and-up column becomes drag-resizable, clamped
   264–420px, persisted per browser in `localStorage`. The `<md` drawer keeps its fixed 264px.

Plus the priority rule the row never had: the title is the only element allowed to grow, it gets a
minimum floor, and metadata is what gives way — encoded as a comment so the next element added to
the row inherits it.

### Non-goals

- **The Tasks table.** It has the column width for full diff numbers and keeps them.
- **The auto-naming format** (`packages/cezar/src/runs/auto-name.ts`). `postValidateTitle` keeps
  writing the `NNN: ` prefix; it is useful on every other surface, and per option C this is a
  *render* concern only.
- **New data in the row** (branch, runner, cost). The row is already over-subscribed.
- **Option A's compact diff formatter and option B's two-line row.** The issue keeps them as
  separate follow-ups; mixing them in would make the chosen option unevaluable.
- **A density/appearance setting** for the list.
- **Server-side or `~/.cezar/ui-state.json` persistence** of the width. It is a browser-local
  preference, like the theme.

## Implementation plan

### Phase 1 — De-duplicate the reference number in the row

`stripRefPrefix` lands beside `runTitle` in `packages/web/src/lib/task-groups.ts` as a pure,
table-tested helper. It matches exactly the shape `postValidateTitle` writes (`^(\d+):\s`) and
nothing looser, and it returns both halves so the caller can decide.

The de-duplication is **conditional on the numbers agreeing**: the prefix is dropped only when the
number it carries is the same number the leading chip is about to show. A task opened on issue
`#788` whose PR later becomes `#790` keeps its `788: ` prefix, because in that row the two numbers
are two different facts and hiding one would be a lie, not a saving.

The leading chip is built from `taskReference(run)` (PR wins once one exists, else the issue), so
the row gains an issue link it never had while losing the duplicated digits. Because an anchor
inside an anchor is invalid, the chip stays a flex **sibling** of the row `<Link>` — which means
the status dot moves out of the `<Link>` too, so the visual order can be dot → chip → title rather
than a chip wedged in front of the dot.

### Phase 2 — Let the column breathe

`packages/web/src/lib/sidebar-width.ts` is the pure half: the clamp, the storage key, and
defensive read/write that survive private mode and garbage values — modelled on `lib/theme.ts`,
which is the house pattern for a browser-local preference. Deliberately its **own** module rather
than an edit to the `sidebar-collapse.ts` that PR #786 is adding, so the two land without a
conflict and each owns one preference.

`AppShell` holds the width in state, paints it as an inline width on the desktop `<aside>`, and
renders a `role="separator"` drag handle on its right border: pointer-captured drag, arrow-key
adjustment, `Home`/`End` to the bounds, double-click back to the default. The drawer is untouched.

### Phase 3 — Prove it

Unit coverage for both pure halves and both components, then e2e at the real 264px column against
a real browser: a seeded run with a long title, a 5-digit diff stat, a PR and an unread marker all
at once must still show a readable number of characters of its name — and the resize must drag,
clamp, persist across a reload and stay absent below `md`.

## Risks

- **The dot leaving the `<Link>`** shrinks the row's click target by ~7px on the left. Accepted:
  the dot is a status indicator with `role="img"`, the wrapper still owns the hover highlight, and
  the alternative (a ref chip in front of the status dot) is worse to read.
- **`stripRefPrefix` over-matching** a title that legitimately begins with a number (`"2026: the
  year in review"`). Mitigated by the numbers-must-agree rule — an unrelated leading number never
  equals the reference the chip is showing — and table-tested.
- **A persisted width that a future layout cannot honor.** Mitigated by clamping on read as well
  as on write, so a stale or hand-edited value can never paint an unusable column.
- **Conflict with PR #786** (`sidebar-collapse.ts`, `last-location.ts`). Mitigated by keeping the
  width in a separate module and not touching the files that PR edits.

## Progress

PR: #789

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: De-duplicate the reference number in the row

- [x] 1.1 Add `stripRefPrefix` to `lib/task-groups.ts` with table tests — d1a366a66bb028b9ea1527e9b3dffedbc2ccb7bc
- [x] 1.2 Render the leading PR/issue ref chip in `RunRow`, drop the trailing PR chip and the now-dead `ReferenceChip compact` mode — 5e8010ae6f0576b10bf0bf03d5bb5f8e82153cc4
- [x] 1.3 Establish the width-priority rule (title floor, droppable metadata) in `RunRow` and the group tile — 5e8010ae6f0576b10bf0bf03d5bb5f8e82153cc4
- [x] 1.4 Unit tests for a row under full width contention (title + diff + PR + unread) — 5e8010ae6f0576b10bf0bf03d5bb5f8e82153cc4

### Phase 2: Let the column breathe

- [x] 2.1 Add `lib/sidebar-width.ts` (clamp 264–420, localStorage, defensive) with unit tests — eb8a7abe75bb126132b5ae2d243f24cb5299af3a
- [x] 2.2 Drive the desktop `<aside>` width from state in `app-shell.tsx` and add the pointer + keyboard resize handle — 34d936be48c5efb350271594ff1d71a962706077
- [x] 2.3 Unit tests for the resize handle in `app-shell.test.tsx` — 34d936be48c5efb350271594ff1d71a962706077

### Phase 3: Prove it

- [x] 3.1 e2e: readable title at 264px, and drag/clamp/persist/`<md`-no-op for the resize — e9d75c0b6f57791229c5b1443adc3d390a533f66, e29cb7608abbb541f80ed9a2c686f8e7b1c53d4d
- [x] 3.2 Full validation gate green — 62a813d1 (typecheck, npm test 5395 passed, test:unit 36, build + check:pack, test:package 12)
