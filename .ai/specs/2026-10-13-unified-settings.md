# Unified settings — one full-screen surface, two URL families

**Status:** implemented in #1413. Supersedes the "Settings split" subsection of
`2026-07-20-multi-project-workspace.md` for the *presentation*; the URL scheme and the store
split that spec introduced are kept on purpose (see "Why the URLs stay").

**Owner decisions (2026-10-13):** the app sidebar is hidden while in settings, which makes
settings the cockpit's first full-screen surface, with its own nav and its own way back. That
nav is the app sidebar's own frame, not a copy of it: `components/sidebar-frame.tsx`
(`SidebarFrame` with the #788 resize handle, `SidebarDrawer`, `useSidebarWidth`) wraps both
sidebars, and one stored width serves both. Inside it, settings keeps the app sidebar's header
row, row heights and footer: the cezar brand lockup and Back at the top, a labelled **General
settings** group above a labelled **Project settings** tree, and the footer with the ⌘K
launcher, the version and star chips and the theme toggle. Below `md` the same content is a
drawer behind a hamburger, in a top bar shaped like the app's (menu and title only). There is
no breadcrumb and no scope badge: the page header reads `project / view` on project pages.

## Goal (the brief)

1. Global settings lists every registered project; a project entry expands into that
   project's own settings sub-nav (Agents, Agent config, Worktrees, Bookmarklets, Prompt
   templates).
2. The **Settings** row under a project in the sidebar still opens that project's settings.
3. The footer gear still opens global settings.
4. The app sidebar is not shown inside settings.

## Today (what the split looks like in code)

- Registry: `packages/web/src/routes/settings/registry.tsx` — each section has
  `scope: 'project' | 'global'`; `visibleSettingsSections(scope)` is "the only thing keeping
  them apart". 5 project sections, 6 global (+ hidden `keyboard`).
- Shell: `settings-shell.tsx` renders ONE shell twice, with `scope` as the only difference —
  the left nav (`data-slot="settings-nav"`, `data-scope`), the mobile pill row, the index
  cards, and a cross-link paragraph telling each half where the other one is.
- Routes: `/p/:projectId/settings[/<id>]` inside the `ProjectScopeRoute` layout;
  `/settings/global[/<id>]` top-level, with no `ProjectScopeProvider` above it.
- App shell: `AppShell` always renders the sidebar column (`md:`) and the drawer + top bar
  (`<md`). No route is chromeless today; `/new` merely has no active nav item.
- Entry points: sidebar nav item `/settings` (per project group: `scopeTo(project.id, '/settings')`);
  footer `GlobalSettingsLink` → `/settings/global`; ⌘K "Settings" view (`/settings` only);
  ~12 deep links to `/settings/agents#providers`, `/settings/global/projects`,
  `/settings/global/resources`.

Three facts constrain the merge:

- **Project sections need the `/p/<id>` URL.** `ProjectScopeProvider` is mounted only by
  `ProjectScopeRoute`; outside it every scoped hook (`useConfig`, `useRepo`, `useAgentConfig`,
  `useWorktrees`, `useUiState`, `useSkills`, `useLaunchKey`) hits the unprefixed `/api/v1/*`,
  i.e. the **boot project, silently**. A project section rendered at a non-`/p/` URL would
  read and write the wrong repo without erroring.
- **`lastLocation` refuses non-`/p/` paths** — client (`lib/last-location.ts`) and contract
  (`workspaceLastLocationSchema.pathname.startsWith('/p/')`). Anything that lives outside `/p/`
  is never restored on the bare root. That is fine for global preferences; it would be a
  regression for a project's Agents page.
- **Moving a section's URL is a BC break** (`BACKWARD_COMPATIBILITY.md` §"Cockpit page URLs":
  "moving a settings section without leaving its old URL redirecting to the new one").

## Decision 1: unify the SHELL, keep the URLs

One settings surface = one left nav + one index, rendered identically at both roots.
The URL families stay exactly as they are:

| What | URL | Scope provider | Store |
| --- | --- | --- | --- |
| Global index (redirect) | `/settings/global` → first global section | none | — |
| Global section | `/settings/global/<id>` | none | `/api/v1/workspace/*` |
| Project index | `/p/<id>/settings` | `ProjectScopeRoute` | — |
| Project section | `/p/<id>/settings/<id>` | `ProjectScopeRoute` | `/api/v1[/p/<id>]/config`, `/ui-state` |

### Why the URLs stay

- Every project section keeps its provider, its cache keys, its `lastLocation` restore and its
  deep links (`/settings/agents#providers` from the thread, the review panel, the inbox, the
  provider banner, the Tools menu, the prompt-template menu) — zero call-site churn.
- No new redirects, no BC entry, no change to `workspaceLastLocationSchema`.
- The legacy flat redirect (`/settings/*` → `/p/<boot>/settings/*`, protected) is untouched.
- The alternative — `/settings/global/projects/<id>/<section>` — would require mounting a
  second `ProjectScopeProvider` by hand outside the layout gate, teaching `last-location` and
  the contract a second path grammar, redirecting every `/p/<id>/settings/<section>` URL, and
  re-pointing a dozen scoped links. All cost, no user-visible gain: the user sees one nav either
  way.

Optional, later: make `/settings` (exact) an alias of global settings instead of the boot
project's index. Not in this plan — it is a protected legacy URL and the boot project's index
now *is* the unified surface with the boot project selected, so a saved `/settings` bookmark
already lands somewhere sensible.

## Decision 2: settings is full-screen (no app sidebar)

### What "in settings" means

One predicate, `lib/settings-path.ts`, used by both the app shell and the settings frame so
they can never disagree:

```ts
/** True for every settings URL, both families: `/p/<id>/settings[/…]` and `/settings/global[/…]`. */
export function isSettingsPathname(pathname: string): boolean
// stripProjectPrefix(pathname) matches '/settings' or '/settings/*'
```

`/settings/skills` (the redirect to the top-level Skills page) matches too; it is a one-frame
redirect, so a flash of the chromeless frame is harmless.

### App shell changes (`app-shell.tsx`)

`AppShell` derives `chromeless = isSettingsPathname(pathname)` and, when true:

- does not render `<Sidebar>` (desktop column) nor `<MobileNavDrawer>`;
- does not render `<MobileTopBar>` — the settings shell brings its own header on every
  viewport (today the mobile top bar is what titles the page "Settings");
- keeps the `banner` row (provider auth failures link INTO settings; hiding the banner there
  would hide the fix from the person about to apply it) and the `composer` row (it is the
  bottom safe-area gutter, not a composer);
- keeps the `<Sheet>` root — it renders no DOM and the drawer state is simply never opened.

The grid stays `auto auto 1fr auto`; the first row is empty in chromeless mode, exactly the
case the explicit `row-start-*` placement was written for (see the shell's layout comment).
`data-slot="app-shell"` gains `data-chromeless=""` so tests and e2e can assert the mode.

Nothing in `app-shell-container.tsx` changes: the queries it runs feed badges that are simply
not rendered in settings, and TanStack keeps them warm for the return trip.

### The settings frame (`settings-shell.tsx`)

The frame is sidebar | (page header, pill row, content), on every viewport.

```
┌─────────────────────┬────────────────────────────────────────────────────┐
│ ◆ cezar    ← Back   │ cezar / Agents   Providers, default runner…        │  page header
├─────────────────────┼────────────────────────────────────────────────────┤
│ GENERAL SETTINGS    │                                                    │
│ Appearance          │   (section body, unchanged)                        │
│ Notifications       │                                                    │
│ Resources           │                                                    │
│ Skills · Secrets    │                                                    │
│ Agent accounts      │                                                    │
│ Projects · Privacy  │                                                    │
│ Stored in ~/.cezar  │                                                    │
│ ─────────────       │                                                    │
│ PROJECT SETTINGS    │                                                    │
│ ▾ cezar             │                                                    │
│    General          │                                                    │
│    Issue tracker …  │                                                    │
│    Agents           │                                                    │
│ ▸ storefront        │                                                    │
│ ▸ old-repo   ✗      │                                                    │
│ ─────────────       │                                                    │
│ 🔍 Search…      ⌘K  │                                                    │
│ v0.15.1  ⭐       ☾  │                                                    │
└─────────────────────┴────────────────────────────────────────────────────┘
```

**Sidebar** (`data-slot="settings-sidebar"` on desktop, `settings-mobile-drawer` below `md`):
the shared `SidebarFrame`, resizable, at the same width as the app sidebar.

- Header row: the brand lockup first, exactly where the app sidebar has it, then `← Back`
  (`data-slot="settings-back"`, see "Leaving settings"), sized so the row does not move when
  settings opens.
- Nav (`data-slot="settings-nav"`, `data-scope` = scope of the current page). The **General
  settings** group lists the global sections as plain react-router `NavLink`s (never
  prefixed), with no `General` row of its own, then "Stored in ~/.cezar".
- **Project settings** tree: one row per registered project, ordered like the sidebar, with a
  chevron, the name and a `folder not found` pill for `missing`. No branch: settings describe
  the repo, not what is checked out. Each project's sections start with **General** (its index
  page), and every link uses an explicit `scopeTo(project.id, …)`.
- Expansion is derived from the URL; the chevron toggles others for the life of the mount, and
  a toggle made on one project's page does not follow the user to another project.
- The project name: on a project page it opens the same section in that project, or its General
  page when General is open, and the previous project folds. On a global page it only toggles.
- One project in the tree: no chevrons, its sections render flat, labelled `This project` when
  the page is about it. A `missing` project is greyed and inert. The unregistered boot worktree
  is never listed.
- On a project page the nav ends with that project's folder path.
- Footer (`data-slot="settings-sidebar-footer"`): the shared `CommandPaletteHint`, then the
  version and star chips and the theme toggle, as in the app sidebar.

**Page header** (`data-slot="settings-header"`, desktop only): the title, `project / view` on
project section pages, then the section's one-liner. The project index reads `project` with
"Project settings" beside it. Global pages show the section title alone.

**Index pages**

- `/settings/global` has no page of its own. It redirects (replace, query and hash kept) to the
  first global section. A card list of the global sections and the projects only repeated the
  sidebar, on desktop and in the drawer (owner's call, 2026-10-14). The URL stays, so the footer
  gear, ⌘K and the project pages' General settings pill still land.
- `/p/<id>/settings` is the project's General page: its folder, registry facts, parallel-task
  ceiling and Remove. Its section cards show below `md` only.

**Mobile (`<md`)**: a top bar (`data-slot="settings-mobile-bar"`) with the hamburger that opens
the drawer, and the page title. Section pages add a pill row of the current area's sections;
project pages lead it with `‹ General settings` (→ `/settings/global`) and a `General` pill.
Back lives in the drawer.

### Leaving settings — where `← Back` goes

Settings is entered from many places (sidebar row, footer gear, ⌘K, ten deep links, a cold
load of a pasted URL) and navigation INSIDE settings pushes history, so `navigate(-1)` is
wrong: it would walk back through settings pages. Instead:

- `lib/settings-return.ts`: a tiny module-level store `{ get(): Location | null, record(loc) }`.
  `LastLocationController` (already the one router listener in `app.tsx`) calls `record` for
  every location that is NOT a settings pathname. So the store always holds the last
  non-settings page the user was on, across any number of settings pages.
- `← Back` navigates to `get()` when set. Fallback (cold load straight into settings): the
  tasks pane of the project in scope — `/p/<id>/` for project pages, `/p/<boot>/` for global
  ones (`useProjects().data?.bootProject`, else the `/` legacy redirect resolves it).
- `Escape` triggers the same, when focus is not inside an input, textarea, select,
  `contenteditable` or an open Radix layer (dialogs own Escape). Registered by the settings
  frame while mounted; unregistered on unmount.
- The store is memory-only. A reload lands on the fallback, which is honest: there is nothing
  to come back to.
- Settings pages are never the remembered launch location (`lib/last-location.ts`), and a
  stored one is not restored. Otherwise a launch at `/`, as the desktop app does, opened the
  settings frame with nothing recorded, and Back's way out went through `/` straight back in
  (found 2026-10-14).

### What the hidden sidebar means for existing behaviour

- **⌘K still works, and stays visible** — the palette is mounted at the app root, not in the
  sidebar, so the chord never depended on the footer. The launcher sits in the settings
  sidebar's footer, on desktop and in the mobile drawer.
- **`New task` CTA and `Add project` are gone in settings.** Both are one `← Back` away; the
  Projects registry pane keeps its own affordances.
- **Live badges (needs-you, inbox, skills update) are not shown in settings.** Accepted by the
  owner as the cost of the full-screen decision. `run-notifications` (browser notifications)
  keep firing — they are not sidebar-bound.
- **The provider banner still shows** (kept row, see above).
- **Document title** is unchanged (`Settings · cezar` for global, `Agents · <project> · cezar`
  for project pages).
- **The boot project's Settings row lighting up on `/settings/global*`** (today's
  `activeNavPath` quirk) becomes unobservable — the sidebar is not rendered there. No fix
  needed; a unit test pins that the sidebar is absent instead.

## Entry points after the merge

| Entry | Target | Change |
| --- | --- | --- |
| Sidebar → project group → Settings | `/p/<id>/settings` | none (lands in the full-screen frame with that project expanded) |
| Sidebar flat nav → Settings (single project) | `/p/<boot>/settings` | none |
| Footer gear | `/settings/global` | none |
| ⌘K "Settings" view | `/settings` (scoped) | add a second view row **Global settings** → `/settings/global` (plain react-router navigate for this one row; the others stay scoped) |
| Projects registry table row | — | add a per-row **Settings** link → `/p/<id>/settings` (explicit scope), absent for `missing` |
| Every existing deep link | unchanged | — |

## Implementation plan (one PR, ordered so each step is testable alone)

1. **Predicate** `isSettingsPathname` in `lib/settings-path.ts` (+ unit test: both families,
   `/settings/skills`, negatives `/p/x/settingsfoo`, `/skills`).
2. **App shell chromeless mode** (`app-shell.tsx`): `chromeless` prop derived inside `AppShell`
   from `useLocation`; skip Sidebar, MobileNavDrawer, MobileTopBar; add `data-chromeless`.
   Keep banner and composer rows.
3. **Return store** `lib/settings-return.ts` + one `record` call in
   `last-location-controller.tsx` (guarded by the predicate).
4. **Extract `CommandPaletteHint`** from `app-shell.tsx` into
   `components/command-palette-hint.tsx` (no behaviour change; the sidebar footer keeps
   rendering it). Pure move so step 5 can reuse it.
5. **Settings frame** (`settings-shell.tsx`): the settings sidebar on the shared frame
   (brand and Back, global rows, project tree, footer), the page header, the mobile bar and
   drawer, and the Escape handler.
6. **Index pages**: the global index redirects to its first section; project index gets the
   project-name `h1`; drop the cross-link paragraph and `settings-global-link`.
7. **Mobile pills**: `‹ General settings` leading pill on project pages.
8. **Registry pane** (`projects-section.tsx`): per-row Settings link.
9. **Command palette**: Global settings view row; update the pinned views list in its test.
10. **Registry helper** (`registry.tsx`): `settingsSectionsByScope(capabilities)` returning
    `{ global, project }` so the nav asks once. `scope` stays on every section — it still
    decides the URL and the store.
11. **Docs**: `README.md:353-357` (already stale — lists MCP and Keyboard, omits Skills,
    Accounts, Agent config) → "one full-screen settings surface; per-project sections under
    `/p/<id>/settings`, everything else under `/settings/global`". `BACKWARD_COMPATIBILITY.md`
    §"Settings split, old URLs kept": one sentence — URLs and redirects unchanged, only the
    nav and the frame changed. `AGENTS.md` project-scoped routes row: same one-liner, plus
    "settings is chromeless" in the Web UI row. Spec `2026-07-20` §"Settings split" and
    §"Sidebar → Footer": pointer to this file.

Not touched: `routes.tsx` route table, `MovedSettingsSectionRedirect`,
`SettingsSkillsRedirect`, `last-location` parsing/contract, `nav-items.ts`, any server code,
`.env.example`.

## Tests

Unit (`npm test -- packages/web/src/routes/settings packages/web/src/components`):

- `settings-shell` predicate test (step 1).
- `app-shell.test.tsx`: at `/p/boot/settings/agents` and `/settings/global/appearance` no
  `[data-slot="sidebar"]`, no drawer trigger, no mobile top bar; `data-chromeless` present;
  banner slot still renders when a banner is passed. At `/p/boot/` everything renders as
  before (the existing footer-row assertions stay).
- `settings.test.tsx`: nav at `/settings/global/appearance` lists global sections AND one row
  per registered project; the URL's project is expanded with explicit
  `/p/<id>/settings/<section>` hrefs; a missing project renders no links; single-project mode
  renders the sections flat and no registry pane; `/settings/global` redirects to the first
  global section with query and hash kept; `/p/boot/settings` index shows the project name.
  The page title reads `project / view`; Back is present; the sidebar footer holds
  `[data-slot="command-palette-hint"]`, which opens the palette, the version and star chips
  and the theme toggle. Existing assertions updated: nav contents (was "only project
  sections"), `settings-global-link` (removed).
- `app-shell.test.tsx`: the sidebar footer still renders the hint after the extraction
  (existing `command-palette-hint` assertions unchanged).
- `settings-return` test: Back goes to the recorded non-settings page after several settings
  hops; cold load falls back to `/p/<id>/` (project) or `/p/<boot>/` (global); Escape in an
  input does nothing, Escape on the page leaves.
- `routes.test.tsx`: `h1` expectations (`Global settings` → `Settings`; project index → project
  name). Redirect cases unchanged.
- `last-location-controller.test.tsx`: settings paths are still never SAVED as lastLocation
  (existing) and now ARE recorded as the return target's *exclusion* (new).
- `command-palette.test.tsx`: 10 views. `projects-section.test.tsx`: per-row Settings href.

E2E (`npm run test:e2e`):

- `settings-appearance.e2e.ts`: nav selector unchanged; add "sidebar absent, Back returns to
  the tasks pane", and "the Search… launcher at the bottom of the settings nav opens the
  command palette".
- `ios-sweep.e2e.ts:160-180`: the mobile top bar assertions on settings pages move to the
  settings mobile bar (`settings-mobile-bar` carries the safe-area inset).
- `smoke.e2e.ts:131-167` (footer rows) runs on the home page — unaffected. `smoke.e2e.ts:220`
  (`/settings/skills` → Skills item active) — unaffected, Skills is not a settings page.
- `project-groups.e2e.ts:302-312` (single-project: no registry pane) — still holds.
- `settings-bookmarklets.e2e.ts`, `tools-menu.e2e.ts:101-118` (Tools → Settings → Agents lands
  on `/p/<boot>/settings/agents`) — unchanged.
- New flow: home → footer gear → `/settings/global` → click second project's Agents in the
  tree → URL `/p/<other>/settings/agents`, Agents form shows that project's runner → `← Back`
  → home.

## Review follow-ups resolved (2026-10-13)

The local `om-code-review` passes found, and this branch resolved: the sidebar width is a
shared store (`useSyncExternalStore`) so a drag in one column moves every mounted column live,
and a drag still applies for the page when storage refuses to persist it; the settings mobile
bar puts the safe-area inset on its outer box; the drawer's rows, chevrons and Back meet the
44px touch rule while the desktop column keeps the app sidebar's sizes; a project's expanded
body id is unique per instance and `aria-controls` is set only while the body exists; the
pill row is a distinct landmark ("Sections of this area") built on the scoped NavLink; a fold
made on one project's page does not follow the user to another project; flat mode renders a
`missing` project inert and names a lone project on global pages; an unknown project id is
named after the boot repo only when it IS the boot project; `?agent=` on Agent accounts
remounts the tabs when it changes.

Known, outside this change: with the registry query in its error state, the scope gate's
fall-through and any page observer of `useProjects` loop (refetch → pending → gate unmounts
the page → mount → refetch) — pre-existing on main for every project page that reads the
registry.

## Checklist of things the split hid (found while planning)

- [ ] ⌘K has no way to reach global settings (step 8).
- [ ] The global Skills section is pinned to the boot project
      (`useSkillsUpdate(projects.bootProject)`); next to a per-project tree, "Skills updates
      for this machine" reading one project's status will look wrong. Out of scope; candidate
      follow-up: move the check under each project's sub-nav or make it workspace-wide.
- [ ] Two places say "Defaults for new projects" (Agent accounts) vs the per-project default
      agent (Agents). The tree makes the pair visible together; wording should say which wins
      ("a project's own choice overrides the default"). Copy only.
- [ ] Project sections have no guard against being mounted outside `/p/`. Cheap insurance:
      `SettingsSectionRoute` for `scope === 'project'` renders the not-found screen when
      `pathnameProjectId(pathname) === null`. Optional.
- [ ] README settings paragraph is stale independently of this work (step 10).
- [ ] `settings-scope-chip` has no test today; the new chip text gets one.
- [ ] The boot project's Settings row lit up on `/settings/global*` via `activeNavPath`. Moot
      once the sidebar is hidden there, but `activeNavPath('/settings/global/x') === '/settings'`
      remains true and would bite any future non-chromeless caller; a one-line note in
      `nav-items.ts` is enough.
