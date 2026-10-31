# First-run onboarding — one action per screen

Status: phase 1 implemented (2026-10-26). Server: `packages/cezar/src/server/repo-suggestions.ts`
(`GET /api/v1/fs/repos`), `packages/cezar/src/server/init-git.ts`
(`POST /api/v1/projects/:projectId/git-init`), `packages/cezar/src/server/publish-github.ts`
(`POST /api/v1/projects/:projectId/publish-github`), `packages/cezar/src/server/github-login.ts`
(`POST/GET/DELETE /api/v1/github/login`). Cockpit: `packages/web/src/components/first-run.tsx`,
`packages/web/src/lib/onboarding.ts`, wired into `routes/tasks-overview.tsx`. Screens (from the running
cockpit): `.ai/specs/assets/2026-10-26-first-run-onboarding/*.png`.

## Problem

The first open of the cockpit says "No tasks yet" and nothing else. It does not say whether an
agent CLI is signed in, and in a folder without git it runs in a degraded single-queue mode that
only a muted sentence on `/new` mentions. Requested for two cases: the folder is a repository, and
it is not.

## Shape

One primary action per screen, everything else quiet. No wizard, no tour, no checklist of
numbered steps — every comparable product (Codex app, Conductor, Linear, Raycast) drops the user
into the product with a single next action.

| State | Shown when | Primary action | Secondary |
| --- | --- | --- | --- |
| Pick your agent / Sign in to an agent | `providers/status` answered, nothing is `connected` and enabled, and the user has not skipped it | Install or Sign in, in a terminal on the page (see "Set up an agent here"); where no terminal can open, the older page: the CLI's login in an external terminal through `POST /providers/connect`, and an install command to copy | Check again, Other agents, Continue anyway |
| Pick a project | the scoped project is `not-git` | a repository from the list; with nothing on disk, three illustrated choice cards (Clone recommended when `gh` is signed in, else New project) | New project, Clone from GitHub (Connect GitHub when `gh` is not signed in), Browse…, Initialize git here |
| Welcome | otherwise, with no runs in the Active view | describe a task (opens `/new?ref=…`) | three task suggestions, then "Or pick up an issue" (the repo's open GitHub issues, in the same card as the repo list) or "Or start with a skill" |
| Setup pill | runs exist and setup is left (worktree scripts, Connect GitHub, Publish to GitHub) | the next setup step | × hides it |

The states replace the `no-tasks` branch of `TasksEmptyState` only; search, filter, archive and
origin empty states are unchanged. `TasksOverview` takes them as optional `firstRun`/`setupPill`
slots, so without them it renders exactly as before.

**Start from.** The three suggestion chips are for an established repository; a fresh one (only the
initial commit, no issues) gets Write a README, Set up tests, Add a CI workflow instead. Under the
suggestions, something real to start from: up to three of the
repository's open GitHub issues (`GET /github`, each a composer prefill through `githubTaskRef`),
or the last three commits as "Or continue recent work", or, failing both, up to four skills (the
project's own first). Setup never shows on
the welcome page — it waits in the pill above the table once the first task exists.

**Activity.** Between the suggestions and the start-from list, a 30-day strip of tasks per day
(from the project's own runs, archived included) — the project's pulse. It renders only once there
is history, so a new project never sees a month of empty bars. When the Active view is empty but
archived history exists, the welcome page shows without the filter bar or the setup pill.

**Repo × GitHub.** No repo: Clone needs a signed-in `gh` (the same `projects/github-owners`
probe the New project dialog uses); without it the link reads Connect GitHub and opens the reason
and `gh auth login`. A local repository with no remote is offered Publish to GitHub in the setup pill. A repository
whose remote is on GitHub but `gh` is missing is offered Connect GitHub.

**Set up an agent here.** Nobody should have to leave cezar to get an agent working. Detection
comes first: with an agent signed in, this page never shows. Otherwise it lists the agents cezar can
install (Claude Code, Codex, OpenCode, Cursor, GitHub Copilot CLI), installed ones first, titled
"Pick your agent" when none is installed. Each row shows the command its button runs. Install opens
a terminal in the row; an exit 0 goes straight on to the login, in the same place, with an "Open
sign-in page" link when the login printed one; the login landing moves the page on by itself.

| From a running terminal | What happens |
| --- | --- |
| Install exits 0, the status says installed | The login starts |
| Install exits 0, the status still says missing | "cezar cannot find it", Try again (the global folder is off cezar's PATH) |
| Install exits non-zero | "did not install", the screen stays, Try again |
| Login lands (status connected, seen by a 3 s re-probe for three minutes and after the exit) | The next page; a login still running is stopped |
| Login exits without signing in | "did not finish", Try again |
| The session disappears (cezar restarted, killed elsewhere) | "closed before it finished", Try again |
| Cancel | The process tree stops, back to the list |
| Reload | Rejoins the session the server still has |
| Leaving the page | An install keeps going and is rejoined; a login is stopped |

The page falls back to the "Sign in does the work" flow below when `GET /providers/setup` answers
`available: false`: a hosted cockpit, single-project mode, `CEZ_TERMINAL=0`, or no PTY binding.

**Sign in does the work.** Where no terminal can open on the page, an installed, signed-out agent gets a Sign in button: `POST
/providers/connect` opens that CLI's login in a terminal (the existing Agents-pane flow), and the
page re-probes the status every 3 s for three minutes, so it moves on by itself when the login
lands. A refused connect (hosted cockpit, no terminal) shows the server's reason and the command
to copy. A missing CLI shows its install command. With every agent turned off there is no row to
sign in to, so the step says so and links to Settings → Agents.

GitHub gets the same treatment, the way GitHub Desktop and the device flow do it: Connect GitHub
and Publish to GitHub start `gh auth login --web` themselves (`POST /api/v1/github/login`), show the
one-time code `gh` printed with a Copy button, open the page that takes it in the browser (local
mode only, once per code) and poll `GET /api/v1/github/login` every 2 s while `gh` waits for the
approval. `done` closes Connect GitHub, and turns Publish into the owner picker; `failed` shows
`gh`'s last line with Try again; a missing CLI (503) shows an install link and Try again. Cancel
kills the login (`DELETE`). One login at a time: a second dialog joins the code already waiting.

**Plain words at every command, and few of them.** Nobody is handed a bare command, and nobody
is handed a paragraph. A missing CLI gets three numbered steps (open Terminal and paste, then sign
in, come back) and a one-line Node.js pointer; a refused connect gets the reason and two steps;
Connect GitHub and Publish show a code and a spinner, nothing to type or paste; the
git-init dialog says in one line what git is for and that cezar runs the commands itself. Every
onboarding dialog has the same frame: a header band (title, one line), the body, a footer band with
the buttons. The sign-in page re-probes the agents every 10 s on its own, so "come back" is enough.

**Skippable sign-in.** Provider detection can miss a login that works (observed on a machine whose
Claude CLI the probe reports `disconnected`), so the sign-in page has Continue anyway, stored as
`onboarding.agentCheckSkipped`.

**Feature announcement.** Above the welcome page, one card for the newest feature the user has not
closed and this cockpit can offer (`ANNOUNCEMENTS` in `lib/onboarding.ts`, newest first). The card carries a violet wash and a small picture of the feature drawn from plain boxes (an app
frame, a picked element, a note), so there is nothing to load and it is right in both themes. The first
is Design Mode, shown only when `capabilities.designMode`; its action opens the composer with a task
that starts the app's dev server, since Design Mode lives in a task's Preview. Trying or closing it
records the id in `onboarding.dismissedAnnouncements`; a new feature gets a new id and shows once.

**Derived, not stored.** Agent from `providers/status`, git from `GET /repo`, worktree setup from
the project config (`worktreeLifecycle.afterCreate` non-empty), GitHub from `health.forge.available
=== false`. The stored bits are `onboarding.setupDismissed`, `onboarding.agentCheckSkipped` and
`onboarding.dismissedAnnouncements` in the workspace ui-state (additive, optional, one person sets up every project),
plus the visit dates below.

**Guidance.** The two obstacle pages — sign in, pick a project — carry a three-step rail (Agent,
Project, First task) derived from the state that picked the page, with the steps behind the current
one ticked, and one line saying why the step matters. The welcome page is the goal, not a step, and
returns in every new project, so it carries neither. No Next buttons: the rail is a thread, not a
wizard.

**Which folder.** "Pick a project" and the Initialize git dialog name the project on screen, looked
up in the registry by its scope id; health always names the folder cezar booted in.

**Layout.** Centered and minimal: a large light title, one primary control, quiet links
or chips under it. Onboarding dialogs centre over the content column (half the desktop sidebar's
width to the right), so they line up with the page they opened from. Hierarchy comes from size; nothing is bold. (A two-column "new project" page
was tried and dropped as heavier.)

**Palette.** Onboarding surfaces (`[data-onboarding]`) use the violet `--primary` family whatever
the user's accent is; the rest of the cockpit keeps its accent. No hero image, no mascot, no background texture, no animation and no Roman/Latin copy.

### `GET /api/v1/fs/repos`

Registered projects first, then folders Claude Code has opened (its `.claude.json` `projects`
keys, newest first — only the keys are read), the checkout root, then a two-level scan of the
browse root. At most 30. Every candidate must lie inside the browse root, the same containment
`fs/browse` uses; the home folder itself and task worktrees are skipped.

It never reads inside a macOS privacy-protected home folder on its own (`Desktop`, `Documents`,
…) — the rule `fs-browse.ts` follows, because reading one makes macOS ask for permission. A
protected path from the registry or agent history is listed without being stat'ed. Refused (409)
under `CEZ_SINGLE_PROJECT=1`, like `fs/browse`.

### `POST /api/v1/projects/:projectId/git-init`

`git init -b main`, `git add -A`, `git commit -m "Initial commit"` in the project root. The files
are committed rather than left untracked because a task worktree branches from HEAD: an empty
initial commit would hand every agent an empty tree. No remote, nothing pushed. 409 when the
folder already has `.git`; when the commit fails (typically no git identity) the `.git` this call
created is removed, so a retry starts clean. A folder with no `.gitignore` gets a short one first
(`node_modules/`, `.env`, `.env.*` except `.env.example`, `.DS_Store`, `*.log`): the first commit
takes every file, and on the way to Publish to GitHub installed dependencies and secrets must not
be among them. The same patterns always go into the new repository's `.git/info/exclude`, so a
project whose own `.gitignore` forgets `.env` still does not commit it; that file is local to the
clone and shared by its task worktrees. A missing git identity is answered with the two `git
config` commands to run. A home folder, a guarded folder directly in it (Documents, Desktop…), a
parent of home and a disk root are refused with 409, compared after resolving symlinks, because
`git add -A` there would sweep up everything the user owns. Single-project mode refuses the route
with 409, like every other registry mutator, and the page does not offer it there.
The cockpit's dialog shows the three commands before running them.

The next task picks the repository up without a restart: run start re-reads `getRepoInfo`, and
the cockpit invalidates the registry, `repo` and `health` queries on success.

### `POST/GET/DELETE /api/v1/github/login`

The GitHub device flow with cezar holding the process. `POST` spawns `gh auth login --hostname
github.com --git-protocol https --web --skip-ssh-key` with no terminal attached (`gh` then prints
the code and the URL instead of waiting for Enter, and opens no browser of its own), reads the
one-time code off its output and answers `{status: 'pending', code, url}`; the device page is
opened in the host's default browser once per code, in local mode only. `GET` is the state the
dialog polls: `idle`, `starting`, `pending`, `done` (exit 0; the GitHub list and project-probe
caches are dropped so the next read sees the sign-in), `failed {error, notFound?}` (`gh`'s last
line). `DELETE` kills the process. A second `POST` while one is pending answers the same code; a
`POST` after `done` or `failed` starts a new login, unless `gh auth status` already reports
github.com signed in, which answers `done` at once. `done` carries the `login` `gh` printed.
Without `gh`: `503 {error, notFound: true}`; no code within 20 s: `500`. Failures are put in
plain words: an expired code, a refusal on GitHub, no network, and a `GH_TOKEN` in cezar's
environment (which `gh` always prefers, so a login cannot replace it). A cancel while the start
is still waiting for its code ends that request too, and a login left waiting is killed when
cezar exits. `POST` and `DELETE` refuse with 409 in single-project mode and in a hosted cockpit:
signing the host's `gh` in changes credentials on the server, so it follows the provider login,
which a hosted cockpit also refuses. `CEZ_DRY_RUN=1` gets a fake code that approves itself after
6 s and opens no browser.

### `/api/v1/providers/setup`

`GET` answers `{available: false, reason}` or `{available: true, agents, session}`. `POST
/sessions` body `{provider, action: 'install'|'login', cols?, rows?}` runs one command in a PTY. The
request never carries the command: `install` comes from `server/agent-setup.ts`, `login` from
`loginCommand`. `output`, `input`, `resize` and `DELETE` work like a task's terminal, reach only
setup sessions, and share its cursor-only topic.

- **Which install command.** npm when its global folder is writable, then the vendor's script
  (Claude Code, Cursor), then `sudo npm`, whose password goes in the terminal. Without npm or curl
  the row shows the CLI's install hint instead of a button. On Windows, Claude Code's native
  installer first, because `resolveClaudeBin` does not accept npm's `.cmd` shim. OpenCode stays
  pinned to `opencode-ai@1`: the runner cannot drive 2.x yet.
- **Where.** The home folder, never the project: a repository's `.npmrc` must not get to redirect an
  install, nor its agent config a login.
- **One at a time.** A second start of the same action joins the running session (200); another agent
  gets 409. The status decides what is allowed, so a stale page cannot reinstall an agent (409) or
  sign in to a missing one (409).
- **Who.** Refused in a hosted cockpit, even with `CEZ_TERMINAL=1`, and in single-project mode:
  installing changes the host, and signing in changes its credentials. Nothing runs before a click,
  so it needs no flag; `CEZ_TERMINAL=0` turns it off.
- **Telemetry.** The existing `provider_login_opened` and `provider_connected`; installs send nothing.
- **Dry run.** `CEZ_DRY_RUN=1` shows the real command and runs an `echo`.
- **Not here.** pi and Junie (no install recipe this repo vouches for), and named agent accounts:
  setup signs in the default account, and Settings → Agents keeps the rest.

### `POST /api/v1/projects/:projectId/publish-github`

Body `{owner, name}`. Requires a committed repository with no remote (409 otherwise).
`gh repo create <owner>/<name> --private`, then the HTTPS `origin` and the persisted `gh`
credential helper exactly as `projects/create` (#968), then `git push -u origin <branch>`. Always
private — no visibility field, and one must never be added. `owner` must be an account `gh`
lists (the `github-owners` list the dialog shows), else 403; 503 without `gh` or when it cannot
list accounts; 409 with "<owner>/<name> already exists on GitHub. Pick another name." when the
name is taken, and in single-project mode, where the setup pill does not offer it; a failure after the GitHub
repository exists says so and never deletes it. When `gh` is not signed in, the Publish dialog runs
the same device-flow sign-in first; if `gh` signs in yet lists no account, it shows why and offers
Check again instead of waiting forever.

## Coming back

Someone who has not opened cezar for a month knows most of it and has lost their place. A second
tour would tell them they remember nothing (Apple's HIG: never show tutorials to returning users
automatically). What they need is their own context back and the few things that moved. The
patterns come from Mobbin: a greeting line on the home page (Gumloop, Causal, Google AI Studio), a
"What's new" dialog with a picture per change (HubSpot, Relume, Lovable), and a permanent "What's
new" row in the sidebar footer (Linear, Riverside).

- **Greeting line.** A visit after `RETURNING_AFTER_DAYS` (14) records `returnedFrom` (the
  previous `lastVisitAt`) and `returnedAt`. For three days, or until closed, one card sits above
  the setup pill: "Welcome back", one sentence of good news, and at most two plain buttons. The
  sentence says what is ready and what is new ("One task is ready for your review, and there are 5
  new features to try."), never how long the user was gone. Review task (or Open task / Open tasks)
  opens the latest waiting task; See what's new opens "What's new" with what shipped after
  `returnedFrom`. With nothing waiting and nothing new, no card shows. No status dots, counters or
  inline links: the table and the sidebar already carry that detail. Closing writes
  `welcomeBackClosedAt`.
- **What's new.** One change per page: a miniature of the feature drawn with the cockpit's own
  surfaces, a "New" label with the date, the title, one sentence, and a link to the feature when
  it has a place ("Open Workflows", "Set up scripts", "Try it"). The footer carries page dots and
  Back/Next, then Done; arrows page and ⌘↵ goes on. The text block has a fixed height, so the
  dialog never jumps between pages.
- **Sidebar footer.** "What's new" is always there, with a dot while something shipped after
  `max(firstVisitAt, whatsNewSeenAt)`; opening it writes `whatsNewSeenAt` and lists the last 90
  days.
- **"New" dots on nav items.** A feature with a nav place that shipped after the user's
  `firstVisitAt`, within 60 days, and that they have not opened, dots its nav item (Settings owns
  `/settings/worktrees`). Opening the page marks it seen (`dismissedAnnouncements`). Never on a
  first visit.
- **Old names still find things.** The task palette matches every label a view has had and what
  moved into it (Preview also answers to Browser and Design Mode, Files to Code, Terminal to
  Shell).

Visits are stamped from the shell at most hourly (`firstVisitAt`, `lastVisitAt`). Announcements
live in `lib/onboarding.ts`, newest first, each dated by the day it merged, with a miniature id,
an optional nav place and action, and an optional hero entry for the welcome page's big card.
Only real, shipped features go in the list.

## Composer (`/new`)

Status: implemented (2026-10-30). `packages/web/src/routes/new-task.tsx`,
`packages/web/src/lib/composer-tips.ts`, `packages/web/src/components/composer-tips.tsx`; the
shared primitives moved to `packages/web/src/components/onboarding-kit.tsx`.

The composer is where the first run lands, so it wears the same grammar: `data-onboarding` on the
route (the violet `--primary` family for Start and the checked chips), a large light title with the
run-mode line under it in the why-line's size, the welcome page's three suggestion chips (icon,
no border), and a plain surface. The twinkle scatter and the ghost-code texture that used to sit
behind the card are gone; the onboarding palette rule — no texture, no hero — applies here too.

### Composer tips

The screen carries a dozen controls, and a tour of all of them teaches none. Each visit explains
at most **two** (`TIPS_PER_VISIT`), one card at a time under the composer: a label ("Tip 1 of 2"),
the control's name, one or two sentences, and a small moving picture of what it does, drawn from
plain boxes like the "What's new" miniatures (rows rising in, a bar filling, a branch drawing
itself, a thumbnail dropping in; still under `prefers-reduced-motion`). The card points at its
control with an arrow placed by measurement and rings the control with a pulsing halo.

- **Order** is the catalog in `composer-tips.ts`: what everyone uses first (`/` for skills, the
  source pill), then what changes how a task runs (worktree, autonomous, variants, model), then
  the rest (attachments, schedule, dispatch, Ask, base branch, follow-ups, templates, project).
- **Only controls on screen.** A tip whose anchor is not rendered (no git, one runner, no
  templates, dispatch off) is skipped, not shown pointing at nothing. The visit's pair is chosen
  once, when the pills first render; a pill that appears later joins the next visit.
- **Closing.** "Got it" / "Next tip" / × close a tip for good; clicking the control it points at
  counts as got it (except the textarea, which the page focuses itself); a card left up for five
  seconds counts as read when the user leaves the page. "Don't show tips" turns them off.
- **The way back.** When nothing is due, a quiet "Tips" link under the composer brings the next
  pair; once every tip on this screen has been closed (or tips are off) it reads "Show me around"
  and walks all of them.
- **Stored** in the workspace ui-state: `onboarding.composerTipsSeen` (ids, capped at 50) and
  `onboarding.composerTipsOff`. Both additive and optional, like the rest of the object.

## Automations

Status: implemented (2026-10-30). `packages/web/src/routes/automations/automations-onboarding.tsx`.

With no automation yet, `/automations` explains instead of showing an empty box: "Let the routine
run itself", one line on what an automation is (a prompt cezar turns into a task on its own), three
tiles for what can start one — On a schedule (recommended), When GitHub changes, When an issue
moves (Jira / Linear) — and three numbered steps for how it goes live: write it as a prompt, preview
then enable (new automations start paused), every run is a task (own worktree, review gate, log).
A tile opens the editor on that trigger (`/automations/new?kind=…`, `initialKind`; the template
palette stays closed). Without the GitHub CLI the GitHub tile says "Sign in to the GitHub CLI first"
and leads to `/github`.

The same four ideas, in pictures, sit behind **How it works** in the page header (`GuideDialog`,
the "What's new" shape: picture, title, one sentence, page dots), for someone who already has
automations. Nothing is stored for it; it is a door, not a tour.

### Automations editor

Status: implemented (2026-10-30). `packages/web/src/routes/automations/editor.tsx`,
`editor-sentence.ts`, `editor-github-fields.tsx`; `SelectTile` and `OnboardingStepRail` in the kit.

`/automations/new` and `/automations/:id` used to be four dense cards beside a rail of previews:
a name box first, a segmented kind switch, raw event ids in mono chips, filters folded away,
the prompt's placeholders listed only as placeholder text, and an "Enabled" switch with a
technical note. The form keeps every field and every data-slot and reads differently:

- **One column that reads as a sentence.** Under the header (unchanged: Back, title, templates,
  Cancel, Save) sits one low strip — the name as a light line (`Name this automation`) on the
  left, the three-step rail When · What · Go live on the right, ticked as the form fills in
  (`railSteps`). The strip sticks under the header while the form scrolls (static below `md`,
  where the header may wrap), so what you are building and how far along you are never leave
  the screen. Then the three parts, split by hairlines, each with a light title and one line on
  why.
- **When.** The trigger is three `SelectTile`s (picture, title, one line; the chosen one wears
  the violet wash; a locked or unavailable one is dimmed with the reason as its tooltip), then
  the trigger's own fields, then the next-runs preview inline where the schedule is, not in a
  side rail. GitHub events read as sentences — "A pull request opens", "An issue gets a label" —
  with the event id as small print and as the chip's accessible name; the poll line is a
  sentence; Filters says how many are set and that names in the prompt do not narrow anything.
- **What the agent does.** An "Insert" row of the placeholders this trigger fills in
  (`PLACEHOLDERS`), put in at the caret with a click; the prompt in the composer's shape; the
  prompt templates, the run-as pills, the dispatch row as before.
- **Go live.** A readback line in plain words — "Every day at 04:00: a quick task on the
  default agent, autonomous." (`draftSentence`) — above the Enabled switch, whose sentence says
  what enabling means for this trigger. Copy as CLI, Preview saved matches and the last run
  sit under it.
- The template palette, when open, sits above the three parts with one line inviting either way in.
- **The name is a form field.** A borderless light line read as a heading, and nobody typed into
  it; it is a labelled input in the strip (`Name`, placeholder `Nightly dependency bump`).
- **One face in the pill row.** The composer's pills come from several components — a mono,
  semibold skill chip, a mono base branch, a bold project pill — and side by side read as four
  typefaces. On an onboarding surface (`/new`, the editor's run-as row) one unlayered rule in
  `index.css` sets them all to the sans face at regular weight; hierarchy comes from size and
  the violet accent.

## Not in phase 1

- "Watch a demo run" on the mock agent — needs a server-side way to run one task on the mock
  runner outside `CEZ_DRY_RUN`.
- Saving an unregistered project on the first task start (seed-once already registers the very
  first boot folder).
- A ⌘K "Resume setup" entry after the setup row was hidden.
- The CLI hint on `npx cezar-run` outside a repository, and `cezar init --git`.
- Replacing the "Runs in place" hint on `/new` with a banner that offers Initialize git.
