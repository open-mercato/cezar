# Execution plan — repository file browser on the Git tab

Source doc: .ai/specs/2026-10-05-repo-file-browser.md
Subject issue: #1279
Spec PR: #1280 (merged 2026-10-06)
Engine: om-auto-create-pr (steps: 15, --loop: no)

## 🎯 Goal

Give the cockpit's project **Git** tab a fourth sub-tab, `/git/files`, that browses the project
repository's own tree (left) and renders the selected file (right) — Shiki-highlighted text,
inline images, rendered Markdown — with an instant client-side filter over the path index. Two
additive read routes back it: `GET /repo/tree` (the whole `git ls-files` index, capped) and
`GET /repo/files?path=` (one file, guarded by index membership).

## 📋 Scope

**In scope** — exactly the spec's two phases:

- Contract: `repoTreeSchema`, `repoFileQuerySchema`.
- Server: a never-throwing `listRepoPaths` helper, `GET /repo/tree`, `GET /repo/files`.
- Client: `getRepoTree`, `getRepoFile`, `repoFileRawUrl`, `useRepoTree`, `useRepoFile`.
- UI: `RepoFilesSection` (tree + viewer + filter), the `files` sub-tab, the `git/files[/*]` routes,
  `FilePreview` generalized to a `source` discriminant, `.md` rendered through Streamdown.
- Docs: `BACKWARD_COMPATIBILITY.md` §2 and `docs/reference.md`.

**Non-goals** (stated in the spec, not touched here):

- Content (grep) search across files — paths only.
- Editing or writing any repo file; nothing in this run mutates the working tree or the index.
- Viewing a file at an older commit, blame, a `?showIgnored=1` toggle.
- Any new `CEZ_*` env var or route-specific hosted-mode gate (spec Q7).
- Virtualizing the tree (spec Q9 — a rendered-result cap answers the unbounded case instead).

## 📝 Deviations from the spec, and why

1. **`listRepoPaths` lands in `packages/cezar/src/server/git-changes.ts`, not `git.ts`.** The spec's
   Architecture section suggests `git.ts` ("beside `getStatus`/`getBranches`"), but its own API
   Contracts section requires the helper to *never throw*, to answer `{ ok: false }`, and to produce
   its 409 wording through `gitReason` — and `git.ts`'s `git()` throws, while the never-throw
   `git()` + `gitReason` + `readWorktreePath` all live in `git-changes.ts`. Placing it beside
   `readWorktreePath`, the other half of this feature, honors the behavioral contract (the
   load-bearing half) without duplicating the subprocess idiom or `gitReason`.
2. **`repoFileQuerySchema` is declared in `packages/contract/src/repo.ts` and consumed by the
   route**, per the spec. `/runs/:id/files` keeps its inline `queryValue` shape untouched — the
   spec's parity requirement is for the new route only, and touching the old one would be a wire
   change nobody asked for.

## ⚠️ Risks

- **The Q5 index-membership guard is the load-bearing security control.** `readWorktreePath` knows
  nothing about `.gitignore`, so without the membership check `?path=.env` would be served verbatim
  from the user's real checkout. Its test is written before the handler (Step 4) and covers the
  ignored-untracked `.env`, the tracked `.env` (served by design), traversal, symlink and `.git`
  cases. Both guards run independently.
- **This reads the user's real working tree**, not an isolated worktree — the material difference
  from the run Files tab. Mitigation is structural: the content route can only serve what
  `git ls-files` returned.
- `FilePreview` is shared with `/tasks/:id/files`; generalizing it to a `source` discriminant is the
  one change that can regress an existing surface. The existing Files-tab tests are the regression
  guard and must pass unchanged.
- `BACKWARD_COMPATIBILITY.md` §2 is enforced by `bc-route-inventory.test.ts` against the built app's
  route table — a new route that is not inventoried fails the suite, so Step 11 is a gate, not polish.
- The browser e2e suite (`packages/web/e2e`) runs in no CI workflow and no browser can launch in this
  environment, so Step 15's e2e is written for local/QA execution and is **not** a merge gate; the UI
  is verified by component tests only. Disclosed on the PR rather than implied as a pass.

## 📋 Implementation Plan

### Phase 1 — Browse and view

1. **Contract** — `repoTreeSchema` (`{paths: string[], truncated: boolean}`) + `RepoTree`, and
   `repoFileQuerySchema` (`{path: min(1), raw?: '0'|'1'}`) + its type, in
   `packages/contract/src/repo.ts` with doc comments naming the routes. Unit test pins `truncated`
   as required and the query schema's rejections.
2. **Index helper** — `listRepoPaths(root, cap, bytesCap)` in `git-changes.ts`:
   `git ls-files -z --cached --others --exclude-standard`, NUL split, drop trailing empty, sort,
   slice, `{ ok: true, paths, truncated }`; `{ ok: false, error }` outside a repo, on a failing
   `ls-files`, and when the captured bytes exceed `bytesCap` (never a partial list).
3. **`GET /repo/tree`** — chained into `repoRoutes`; `getRepoInfo` → `409 'not a git repository'`,
   verbatim `/repo/changes` wording; `listRepoPaths` failure → 409 with git's first stderr line.
4. **`GET /repo/files`** — chained in with `repoFileQuerySchema` through `queryZodValidator`; derive
   the index, refuse non-members with `path is not in the repository index: <path>`, then
   `readWorktreePath`; mirror `/runs/:id/files`' raw-image negotiation, `vary: Accept` and response
   headers. Security tests first.
5. **Client + hooks** — `getRepoTree`, `getRepoFile`, `repoFileRawUrl` in `client.ts`; `useRepoTree`,
   `useRepoFile` in `queries.ts` with `queryKeys.repoTree` / `repoFile(path)` under the `repo`
   prefix, both `retry: false`.
6. **Generic tree builder** — extract path-splitting + single-child compaction out of
   `buildFileTree` into a builder over plain paths; re-express the changed-files builder on it. The
   existing `file-tree` suite is the regression guard.
7. **`RepoFilesSection` + tree** — `packages/web/src/routes/repo-git/repo-files.tsx`: tree from
   `useRepoTree`, closed folders, auto-expanded ancestors of the selection, truncated banner, empty
   state, mobile tree⇄viewer swap with a back control.
8. **Tab wiring** — `RepoTab` gains `'files'`; one `TabLink`; `git/files` and `git/files/*` routes;
   deep-link selection from the splat, `replace` history on selection.
9. **Viewer reuse** — `FilePreview` takes `source: {kind:'run';runId} | {kind:'repo'}` routed through
   one `useFileEntry(source, path)` hook; `task-files.tsx` passes `{kind:'run', runId}`.
10. **Markdown** — export `shikiPlugin` from `markdown.tsx`, render `.md` through Streamdown with a
    `Rendered | Source` toggle defaulting to rendered, persisted for the session; no second
    `createHighlighterCore`.
11. **Docs** — `BACKWARD_COMPATIBILITY.md` §2 gains both routes; `docs/reference.md` gains the tab.

### Phase 2 — Search

12. **Matcher** — a pure `matchPaths(paths, query, limit)` module: case-insensitive subsequence,
    basename-first then shorter-path ranking, capped, `{results, total}`.
13. **Filter UI** — the input, the flattened full-path result list, the "N more" footer, the
    empty-result message, `/` to focus and `Escape` to clear.
14. **Keyboard + a11y pass** — `role="tree"`/`treeitem`, `aria-expanded`, roving `tabindex`,
    ↑/↓/←/→/Enter, a polite live region on the result count.
15. **End-to-end** — one local/QA e2e: open `/git/files`, filter, open a file, confirm highlighted
    content, then a `.md` and confirm rendered output. Not a merge gate (see Risks).

## Progress

PR: #1299

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Browse and view

- [x] 1.1 Contract — repoTreeSchema and repoFileQuerySchema — a9732170
- [x] 1.2 Index helper — listRepoPaths — a9732170
- [x] 1.3 GET /repo/tree — a9732170
- [x] 1.4 GET /repo/files with the index-membership guard — a9732170
- [x] 1.5 Client functions and query hooks — 7015f341
- [x] 1.6 Generic tree builder over plain paths — 7015f341
- [x] 1.7 RepoFilesSection and the repo tree — 7015f341
- [x] 1.8 Tab wiring and the git/files routes — 7015f341
- [x] 1.9 FilePreview source discriminant — 7015f341
- [x] 1.10 Markdown rendering with the Rendered/Source toggle — 7015f341
- [x] 1.11 Docs — BACKWARD_COMPATIBILITY §2 and docs/reference.md — a9732170 + 4ccdaab8

### Phase 2: Search

- [x] 2.12 matchPaths matcher module — ab2b03b5
- [x] 2.13 Filter UI over the loaded index — ab2b03b5
- [x] 2.14 Keyboard and accessibility pass — ab2b03b5
- [x] 2.15 End-to-end spec (local/QA only, not a merge gate) — ef126571

## 🧪 Validation

Full gate, env-cleared (`TMPDIR`/`TMP`/`TEMP` plus every `CEZ_*` unset — this repo's suites read
them, and leaving them set fails ~2 unrelated tests):

| Command | Result |
|---|---|
| `npm run typecheck` | ✅ — includes the mutual `contract-parity` assertions for both new routes |
| `npm test` | ✅ 8972 passed, 3 skipped, 0 failed (528 files) |
| `npm run test:unit` | ✅ 0 failed |
| `npm run build` | ✅ `check:pack ok — 745 files` |
| `npm run test:package` | ✅ 17 passed |

New coverage: 24 server cases (`repo-files-api.test.ts`), 10 matcher cases, 19 component cases in
`repo-git.test.tsx`, 5 generic-tree-builder cases, and one browser e2e spec.

**Not verified:** the browser e2e (`packages/web/e2e/repo-files.e2e.ts`) was written but never run —
no browser can launch in this environment (bundled Chromium needs `libnspr4`, no passwordless sudo)
and the suite runs in no CI workflow, so a green pipeline says nothing about it. There are therefore
no UI screenshots for this run; the UI is covered by component tests only. Performance on a
repository near the 20 000-path cap is inferred from the cap, not measured.
