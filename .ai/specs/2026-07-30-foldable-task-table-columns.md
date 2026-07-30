# Foldable Task Table Columns

## 📝 TLDR

Let users fold optional columns in the desktop Tasks table to reclaim horizontal space without losing the table’s core status and task identity. Branch starts folded on a fresh workspace, every optional column—including Workflow—can be toggled from its header, and the choice persists as workspace UI state across projects and browser sessions.

## Resolved assumptions (autonomous defaults)

| # | Applied default | Rationale |
|---|---|---|
| Q1 | Only Branch is folded by default; Workflow and the remaining optional columns start expanded. | This directly satisfies issue #738 while changing the smallest amount of the current table on upgrade. |
| Q2 | Status and Task are permanently expanded; Workflow, Branch, ±, Ref, Tokens, Cost, CPU, Mem, and Started are foldable when present. | The issue explicitly protects Status and Task and asks for a general mechanism rather than one-off Branch logic. |
| Q3 | A folded column keeps a narrow, icon-based header control while its row values are visually and accessibly omitted. | The column must remain discoverable and independently restorable without adding a separate settings surface. |
| Q4 | Column state is a workspace-global preference in `~/.cezar/ui-state.json`. | Table layout describes the person using the cockpit, not repository data, and should not reset when switching projects. |
| Q5 | The feature applies only to the desktop table; mobile task cards keep their current compact metadata layout. | Header-click interaction has no mobile-table equivalent, and changing cards would widen the feature without solving the reported problem. |

## 📝 Problem Statement

The Tasks overview currently gives every desktop column its full intrinsic width. Long workflow names and branch chips make the table overflow horizontally, forcing users to scroll even when those details are not relevant to the current scan. Issue #738 specifically calls out Branch, asks that it begin folded, requires Workflow to be foldable too, and asks for a reusable mechanism that can cover the other nonessential columns while Status and Task remain visible.

## 📝 Proposed Solution

Define a small task-column registry that owns each column’s stable id, label, icon, alignment, default expanded state, and whether it may fold. Render the desktop header and matching row cells from that registry so structural alignment cannot drift. A header button toggles an optional column between its full cell and a narrow restore control; Status and Task render as noninteractive headers.

Persist explicit user overrides in workspace UI state. Missing state uses the defaults, so Branch folds without creating or migrating a file and every other current column stays expanded.

### Column policy

| Stable id | Header | Foldable | Fresh-workspace default |
|---|---|---:|---:|
| `status` | Status | No | Expanded |
| `task` | Task | No | Expanded |
| `workflow` | Workflow | Yes | Expanded |
| `branch` | Branch | Yes | **Folded** |
| `diff` | ± | Yes | Expanded |
| `reference` | Ref | Yes | Expanded |
| `tokens` | Tokens | Yes | Expanded when the token-metrics capability is visible |
| `cost` | Cost | Yes | Expanded when the token-metrics capability is visible |
| `cpu` | CPU | Yes | Expanded |
| `memory` | Mem | Yes | Expanded |
| `started` | Started | Yes | Expanded |

“Folded” is not the same as removing the column. The logical column keeps a narrow header cell so the user can restore it in place, but its row value is not rendered. This is a better fit for the requested header-click interaction than a detached “Columns” menu: the restore affordance stays where the information will reappear.

The registry is a project-owned primitive, not a reason to add a table framework. TanStack Table and MUI Data Grid both model visibility as stable column ids mapped to booleans and allow identity columns to opt out of hiding. Cezar can reuse that useful state shape without importing their sorting, pagination, or row-model machinery into a single readable component. The Cezar-specific folded-header interaction is deliberately smaller than their toolbar/menu surfaces.

References:

- [TanStack Table — Column Visibility Guide](https://tanstack.com/table/latest/docs/guide/column-visibility)
- [MUI X — Data Grid Column Visibility](https://mui.com/x/react-data-grid/column-visibility/)

### Alternatives considered

1. **Special-case Branch with local component state.** Rejected because it would satisfy only the first sentence of #738, could not cover Workflow or later columns, and would reset on reload.
2. **Hide optional columns from a toolbar menu.** Rejected for this iteration because the issue explicitly asks for header-click expansion. A menu also makes restoring one hidden column require leaving the scan position.
3. **Persist a list of hidden column ids.** Rejected in favor of an `expandedColumns` map because an explicit boolean composes cleanly with optimistic updates, records either user choice, and gives new columns an independent default when their id is absent.
4. **Store the preference in per-project `.ai/cezar/ui-state.json`.** Rejected because column density is a user/workspace preference. Switching projects should not change the table shape.
5. **Adopt TanStack Table or MUI Data Grid.** Rejected because the current table has no need for their broader state machine. A declarative local registry provides the visibility invariant with less dependency and migration risk.

## 📝 Architecture

```text
~/.cezar/ui-state.json
  └─ taskTable.expandedColumns
       └─ GET/PUT /api/v1/workspace/ui-state
            └─ session-global TanStack Query workspace ui-state cache
                 └─ useTaskTableColumns()
                      ├─ task-column registry + default resolver
                      ├─ desktop <colgroup>/<thead>
                      └─ matching desktop row cells
```

### Shared contract and server boundary

Add the optional `taskTable` field to the response-side `workspaceUiStateSchema` in `packages/contract/src/workspace.ts` first. The nested object is an open bag so a newer cockpit’s table preferences survive round-trips through an older server:

```ts
taskTable: z
  .looseObject({
    expandedColumns: z.record(z.string(), z.boolean()).optional(),
  })
  .optional()
```

Define a separate `setWorkspaceUiStateInputSchema` in `packages/contract/src/workspace.ts` for the PUT request. Derive it from shared open sub-shapes, but override `taskTable.expandedColumns` with write-only bounds: at most 50 entries and keys of 1–64 characters. Keep unknown `taskTable` siblings and unknown top-level keys, subject to the existing top-level key cap. Export its inferred input type through the contract/api-client rather than hand-writing a request type.

Use `setWorkspaceUiStateInputSchema` directly in the route’s `jsonZodValidator` middleware. Do not duplicate the field in a server-local zod object: the contract must remain the single source for the request and response shapes. The response schema keeps unknown ids and newer nested siblings open, while the request schema prevents this cockpit from writing an unbounded map. Do not narrow either schema to the current column-id enum: forward-compatible ids must survive even when an older server does not render them.

No route is added. The existing chained workspace route family continues to expose:

- `GET /api/v1/workspace/ui-state`
- `PUT /api/v1/workspace/ui-state`

The contract-parity tests must prove the route response and `workspaceUiStateSchema` remain exact in both directions. Typed-body tests must separately prove that PUT accepts `setWorkspaceUiStateInputSchema` and rejects malformed or over-limit maps through middleware; no handler-side parse or loose route registration is introduced.

### Cockpit state controller

Add a focused controller beside the Tasks overview, or in a small `lib/task-columns.ts` plus hook module if that keeps `tasks-overview.tsx` readable:

- `TASK_COLUMNS` is the single ordered registry.
- `normalizeExpandedColumns(raw)` defensively accepts `unknown`, keeps only boolean values keyed by known foldable ids for rendering, and treats malformed user-edited state as absent. The original open object remains in the query cache so unknown ids and siblings still round-trip.
- `isColumnExpanded(id, normalized)` returns the stored boolean when present, otherwise the registry default.
- `useTaskTableColumns()` reads `useWorkspaceUiState()`, exposes resolved state and `toggleColumn(id)`, and refuses ids whose registry entry has `canFold: false`.
- A toggle optimistically replaces the workspace UI-state query cache, preserving the whole current `taskTable` object and `expandedColumns` map.
- Start one small PUT immediately per toggle and serialize them through a write chain; header clicks are infrequent enough that a debounce adds more lifecycle risk than useful load reduction. Tag writes with a monotonic sequence so only the newest response may replace the optimistic cache and an older response cannot resurrect stale state.
- Send these bounded preference writes with Fetch `keepalive` enabled so an in-flight click can complete during page navigation or tab close. The server’s newest merged answer replaces the optimistic cache. On failure, show a danger toast and invalidate the workspace UI-state query so the next render returns to persisted truth.

The existing PUT merge is shallow at the top level. Every write must therefore send the whole `taskTable` object, including the whole `expandedColumns` map and any unknown sibling keys already cached.

### Table rendering

Keep the semantic HTML table and current row-click behavior. Refactor only enough to guarantee that the ordered header and row cells consume the same registry:

- `Status` and `Task` use fixed non-foldable definitions.
- Every optional header renders a real `<button type="button">` inside `<th scope="col">`.
- Expanded cells reuse the existing Workflow, Branch, diff, reference, token, cost, usage, and age renderers.
- Folded cells remain structurally present but contain no user data and are marked presentation-only. The narrow header is the only interactive content for that logical column.
- A `<colgroup>` or equivalent registry-derived width model pins folded columns to a narrow width and removes the unconditional `min-w-[1040px]` floor that would otherwise erase the space saving. The table still fills the available card width, Task receives the flexible remainder, and true overflow keeps the existing horizontal scroll.
- `Tokens` and `Cost` remain governed first by `tokenMetricsVisible(health)`. If the deployment capability removes them, neither header nor cell renders, but their saved preferences remain untouched for a later server where the capability is visible.
- The queued-row note continues to span the two logical CPU/Mem cells. Because folding keeps those structural cells, `colSpan={2}` stays correct even when either value column is folded.

The registry must not leak into mobile cards. The current card metadata order and omission rules stay as they are.

## 📝 Data Model

Workspace UI state gains one optional, additive preference:

```json
{
  "taskTable": {
    "expandedColumns": {
      "branch": true,
      "workflow": false
    }
  }
}
```

Semantics:

- Missing `taskTable`, missing `expandedColumns`, or a missing column id means “use the registry default.”
- `true` means the row values and full header are expanded.
- `false` means the column is folded to its narrow restore header.
- Unknown ids and unknown `taskTable` siblings are preserved on writes and ignored by the current renderer.
- `status` and `task` values in a manually edited file are ignored because the registry marks those columns non-foldable.
- The client does not materialize defaults merely by loading the page. State is written only after a user toggles a header.

The state lives in `~/.cezar/ui-state.json` through the existing `cezarHomeDir()` path and merge-write machinery. No migration is required. Deleting the file restores the zero-config defaults on the next run.

## 📝 API Contracts

Existing responses gain the optional `taskTable` field described above:

```json
{
  "appearance": {
    "accent": "lime"
  },
  "taskTable": {
    "expandedColumns": {
      "branch": false
    }
  }
}
```

An update sends the complete top-level object being changed:

```http
PUT /api/v1/workspace/ui-state
Content-Type: application/json

{
  "taskTable": {
    "expandedColumns": {
      "branch": true,
      "workflow": false
    }
  }
}
```

The response is the fully merged `WorkspaceUiState` and is validated/documented by `workspaceUiStateSchema`; the PUT body is independently validated by `setWorkspaceUiStateInputSchema`. Validation behavior remains the existing `{ "error": "..." }` with HTTP 400 for malformed booleans, overlong ids, too many entries, or an over-limit request body.

No project-scoped alias is added because workspace UI state is intentionally single-mount and cross-project. No WebSocket or SSE event is needed: the preference is controlled by the active browser, reconciled immediately in the local query cache, and persisted by the existing mutation.

## 📝 UI/UX

The desktop Tasks table remains the only affected surface. A proposed folded header must be recognizable, keyboard-operable, and expose an accessible name such as “Expand Branch column”; expanded optional headers expose “Fold Branch column.” Mobile cards, row navigation, inline rename, and Active/Archived/search behavior do not change.

### Expanded optional header

- Shows the existing uppercase label and a subtle inward chevron.
- The whole header content is a button, not a click handler on `<th>`.
- Hover/focus treatment communicates that the column can fold without making every header visually loud.
- Accessible name: `Fold {label} column`.

### Folded optional header

- Uses a narrow square-ish width, the column’s recognizable icon, and an outward chevron.
- Shows a tooltip with the full label and “Expand column.”
- Accessible name: `Expand {label} column`.
- Does not retain the row’s value as visually hidden text; folding is a real information-density choice for assistive technology too.

### Non-foldable headers

Status and Task keep their current plain labels and expose no misleading button, chevron, or keyboard stop. They remain visible in every saved or malformed state.

### Visual evidence

- Current Cezar Tasks table: [`assets/foldable-task-table-columns/current-01-tasks-overview.png`](assets/foldable-task-table-columns/current-01-tasks-overview.png)
- Proposed fresh-workspace state with Branch folded: [`assets/foldable-task-table-columns/mockup-01-branch-folded.png`](assets/foldable-task-table-columns/mockup-01-branch-folded.png)
- Proposed user-customized state with Workflow and Branch folded: [`assets/foldable-task-table-columns/mockup-02-multiple-columns-folded.png`](assets/foldable-task-table-columns/mockup-02-multiple-columns-folded.png)

### Accessibility and interaction

- Header buttons work with Enter and Space and have a visible focus ring.
- Use `aria-pressed` to expose the expanded/folded state; the action-oriented accessible label says what the next click does.
- Icons and chevrons are decorative (`aria-hidden`); the button name never depends on icon recognition.
- Folding a column does not move focus. The same button remains mounted and becomes its restore control.
- Row click interception already excludes `button`, so toggling a header cannot navigate into a task.
- Column order never changes, preventing a user from losing the restore control after a toggle.

## 📝 Edge Cases & Failure Scenarios

- **No saved state:** Branch is folded and every other available optional column is expanded. No file is written just to record defaults.
- **Older workspace UI-state file:** The absent key parses and the defaults apply.
- **Newer file with unknown column ids:** The renderer ignores unknown ids; the client preserves them when it writes a known toggle.
- **Malformed Status/Task overrides:** The renderer ignores them and keeps both columns expanded.
- **Persistence failure or read-only home:** The optimistic change is reconciled back to server truth after a toast. Cezar remains a working cockpit with the default layout.
- **Rapid toggles:** Optimistic cache reads compose, serialized PUTs preserve click order, and only the newest response reconciles the cache.
- **Navigation immediately after a toggle:** The PUT starts on the click and uses Fetch `keepalive`, so the small bounded preference payload may complete after the document begins unloading; there is no component-unmount-only flush that silently launches an ordinary abortable request too late.
- **Two Cezar/browser processes update near-simultaneously:** The existing file merge prevents unrelated top-level preferences from being lost. Same-map last-write-wins is acceptable for a personal presentation preference; each writer sends its complete cached map.
- **Token metrics disabled:** Tokens and Cost are absent, not narrow folded stubs. Saved booleans are retained and take effect if the capability later becomes visible.
- **Queued row:** The queue note keeps correct CPU/Mem span and remains readable at the minimum folded widths.
- **All optional columns folded:** Status and Task still identify every row; each optional column remains recoverable from its ordered header icon.
- **Narrow desktop viewport:** The folded defaults reduce overflow. If the protected columns plus restore controls still do not fit, the existing horizontal scroll remains available.
- **Mobile viewport:** Cards render exactly as today and do not fetch or write a separate column state.
- **Archived tab and search results:** Both table modes consume the same workspace preference and do not create parallel state.

## 📝 Risks & Impact Review

### Compatibility

`~/.cezar/ui-state.json` is a protected user-owned surface. The change is additive: both `taskTable` and `expandedColumns` are optional, the parent and nested object preserve unknown keys, and no existing key changes meaning. Older Cezar versions continue to parse and round-trip the unknown top-level key under the existing passthrough and merge-write contract. No migration or manual repair is required.

The workspace UI-state response gains an optional field. Update `packages/contract` first, keep the route response exact, and retain contract-parity coverage. No endpoint is removed, renamed, or moved.

### Structural table drift

The main implementation risk is a header/cell count mismatch—especially with deployment-hidden token columns and queued CPU/Mem spans. A single ordered registry and tests that compare headers with each row’s logical cells are the guardrail. Do not implement independent `if (expanded)` branches in unrelated header and row blocks.

### Discoverability

An icon-only folded header saves the most space but can be obscure. Tooltips, consistent chevrons, stable order, and accessible labels make the interaction learnable. The mockups must verify that the controls are recognizable in both light and dark themes without turning the header into an icon toolbar.

### Preference scope

Workspace-global state means a toggle in one project affects every project. That is intentional because table density describes the user’s cockpit layout. The implementation issue and release note should call this out so reviewers do not accidentally place the key in per-repo state.

### Rollback

Reverting the UI and schema additions restores the current fixed table. The optional `taskTable` key may remain on disk as unknown data; existing passthrough behavior preserves it harmlessly, and a later reintroduction can reuse it. Deleting `~/.cezar/ui-state.json` also restores defaults but is never required.

## 📋 Phasing

### Phase 1 — Complete persisted foldable-column capability

Ship the additive workspace state contract, registry, persistence controller, accessible table interaction, and visual verification together. The state contract without the header interaction has no independent user value, while the UI without persistence would not satisfy #738; one atomic phase keeps the public behavior honest.

## 📋 Implementation Plan

### Phase 1 — Complete persisted foldable-column capability

1. Add optional `taskTable.expandedColumns` to response-side `workspaceUiStateSchema`, plus a bounded `setWorkspaceUiStateInputSchema`, in `packages/contract/src/workspace.ts`; wire the latter directly into the existing route middleware. Extend workspace UI-state API, contract-parity, and typed-body tests to prove empty/default files still answer `{}`, valid maps round-trip, unknown nested keys survive, malformed maps are rejected without writes, and request-only bounds are enforced.
2. Add the ordered task-column registry plus defensive normalization and pure resolution/update helpers near `packages/web/src/lib/tasks-table.ts` (or a dedicated `task-columns.ts` if clearer). Unit-test stable order, Branch’s default-folded state, default-expanded optional columns, immutable Status/Task behavior, malformed user-edited state, stored overrides, and ignored unknown ids.
3. Add `useTaskTableColumns()` using `useWorkspaceUiState`, `putWorkspaceUiState`, and `workspaceQueryKeys.uiState`. Cover optimistic cache updates, full nested-map preservation, serialized rapid toggles, stale-response suppression, keepalive requests during navigation, authoritative response adoption, and failure toast/invalidation.
4. Refactor `packages/web/src/routes/tasks-overview.tsx` so desktop headers and row cells share the registry, while existing cell renderers and mobile cards remain intact. Add registry-derived widths, folded header buttons, blank presentation cells, and remove the fixed minimum width that prevents folding from saving space.
5. Extend `packages/web/src/routes/tasks-overview.test.tsx` for mouse and keyboard toggles, accessible names/state, fixed Status/Task columns, fresh and persisted defaults, row/header alignment, hidden token-metric capability, queued CPU/Mem span, archived/search reuse, and unchanged mobile cards.
6. Run the configured validation gate, boot the real Cezar UI, and exercise a fresh state plus persisted reload. Capture desktop screenshots with only Branch folded and with Workflow + Branch folded at representative widths; confirm there is no unexpected navigation, focus loss, clipped restore control, or horizontal overflow regression.
