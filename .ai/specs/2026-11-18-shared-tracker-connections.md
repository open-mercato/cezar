# Shared tracker connections

> Status: proposed (2026-11-18). Amends [Browse Jira and Linear tasks alongside GitHub](2026-09-18-jira-linear-tracker-browsing.md)
> § Vendor Behavior and Credentials, which says credentials are entered per project and never reused implicitly.

## 📝 TLDR

Today every project stores its own Jira/Linear credentials, so a user with ten repos on one Jira
site types the same site, email and token ten times. The credential form gains a **Visible only
for this project** checkbox. Checked (the default) is today's behaviour. Unchecked stores the
credentials as a **shared connection** in the same encrypted store, and another project can then
**pick** it in its own Settings instead of re-typing, and choose its Jira project or Linear team as
today. An existing project connection can be **shared** (promoted) in place.

## 📝 Rules that do not change

- Consent is per project and explicit. A shared connection is used by a project only after a
  user picks it in that project's Settings. Nothing links automatically: not when exactly one
  shared connection exists, not on clone, move or a new worktree (task worktrees keep using the
  registered root). Spec 2026-09-18 line "never move/reuse credentials implicitly" still holds.
- Secrets stay write-only, encrypted at rest under the vault data key, outside every repository,
  never in `process.env`, agent environments, logs or API responses. No global environment
  fallback.
- Caches, cursors, associations and automations stay bound to a project and a connection revision.

## 📝 Storage

Same directory as project records, `CEZ_HOME/tracker-connections/`, same modes, bound, atomic
writes and lock protocol.

| File | Content | AAD |
| --- | --- | --- |
| `shared-<uuid>.vault` | `{id: uuid, credentials, createdAt}` (strict) | `managed:tracker-shared` + uuid |
| `<sha256(root)>.vault` | either today's `{id, projectRoot, credentials}` or a link `{id, projectRoot, sharedId}` (both strict) | `managed:tracker` + hash (unchanged) |

- **A link is a project's consent**, stored in place of its own credentials, so a project has
  exactly one entry: own credentials or one link. Replacing either goes through the existing
  commit path (legacy `.env` migration, `.migrated` marker, atomic rename, recovery after a
  post-rename failure).
- **Every link has its own revision id**, a fresh UUID per pick. `read(root)` returns that id with
  the shared credentials. Two projects using one shared connection therefore never share a
  provider cache entry, cursor namespace or association id, and unlinking then re-picking issues a
  new id, so an association, automation or project classification bound to the old link stays
  disconnected until the scope is reconnected, exactly like replacing credentials.
- **Promote** writes a new shared record and replaces the project's record with a link that keeps
  the project's existing id, so its saved scope and automations stay connected.
- **Failure order:** the shared record is written first under a fresh UUID (a file already at that
  name is refused; the check is not atomic, which a random UUID makes moot), then the project lock
  is taken and the link committed. The commit never re-reads the shared record after its rename, so
  a link that reached disk is reported as saved. When the commit certainly failed, the new shared
  record is deleted, unless some project already links to it; when it may have reached disk, the
  record is kept (an orphan is recoverable with `cez tracker-connections`, lost credentials are
  not). The two locks are never held together. A failed commit leaves the previous project entry.
- Picking the shared connection a project already uses keeps its revision (an idempotent retry).
  Using a shared connection in a project that has its own credentials asks for confirmation,
  because those credentials are deleted.
- **Removing** a project's credentials (`DELETE /tracker/connection`) on a linked project removes
  only the link. Deleting a shared record is explicit (`cez tracker-connections remove
  shared-<uuid>`); projects that used it then report "The shared connection this project used was
  removed…" until they pick another or save credentials.
- Shared records are `.vault` files in the same directory, so the key-loss blocker scan in
  `secrets.ts` counts them, and `cez tracker-connections list/remove` reaches them.

## 📝 API

All project-scoped and dual-mounted; contract in `packages/contract/src/tracker.ts`.

| Route | Request → response |
| --- | --- |
| `PUT /tracker/connection` | `trackerConnectionInputSchema` = credentials + optional `shared: boolean` (absent = project-only) → `trackerConnectionResponseSchema` |
| `GET /tracker/connection` | adds optional `connection.shared: true` (present only when linked) |
| `GET /tracker/connection/shared` | → `{connections: [{id, kind, label, createdAt, current}], demo}` |
| `PUT /tracker/connection/shared` | `{id}` → `trackerConnectionResponseSchema`; 404 unknown id; 409 storage failure or demo |
| `POST /tracker/connection/promote` | → `trackerConnectionResponseSchema`; 409 nothing to promote, already shared, or demo |

Two-segment paths, so `/tracker/:id` never shadows them. `label` is built per provider
(`sharedLabels` in `tracker/index.ts`, exhaustive over `TrackerKind`): Jira is the site host with a
masked email (`acme.atlassian.net — d…@acme.com`), Linear is "Linear API key · saved <date>"; both
end with the first four characters of the shared id, so similar connections stay distinguishable. The
2026-09-18 rule "GET responses expose only `{id, kind}`" is amended for this list only: the host and
a masked email are what tell two Jira accounts apart, and they are not secrets. The CLI still prints
no email.

## 📝 UI

Settings → Issue tracker:

- The credential form has a **Visible only for this project** checkbox, checked by default. The
  default submits exactly today's body (no `shared` key).
- When shared connections exist, a **Use a shared connection** card lists them by label with a
  **Use** button. Using one replaces this project's own credentials; the card says so.
- A project with its own credentials gets **Share with other projects** (promote).
- A linked project says it uses a shared connection; **Remove project credentials** becomes
  **Stop using shared connection** and only unlinks.

## 📝 Compatibility

Additive per `BACKWARD_COMPATIBILITY.md` §1/§2/§9. Older versions ignore `shared-*` files and read a
linked project's record as invalid (their existing fail-closed message), and can still replace or
remove it. Downgrading with linked projects needs a separate home, as for the 2026-10-27 encrypted
records; an older CLI cannot remove `shared-*`, so delete those files by hand. `cez tracker-connections
list` adds rows without a new status value: a link reads `valid` while it resolves and `invalid`
once its shared record is gone, so `status != valid` cleanup scripts never drop a working link.

## 📝 Risks and limits

- Same-user boundary as today: any local process that can reach the cockpit API can link any
  project, as it can already save credentials into any project. Sharing makes one token usable by
  more projects, so the docs keep recommending narrowly scoped tokens.
- `probeRoot` (project list classification) decrypts two records for a linked project instead of one.
- CLI changes emit no `tracker-changed` event (unchanged gap); the next tracker read sees them.

## 📝 Follow-ups (not in this change)

- **Rotate a shared connection in place.** Jira tokens expire. The planned path: "Replace shared
  credentials" rewrites the shared record and gives every link a fresh revision in one operation
  (links are local and can be scanned), so each project reconnects its scope once, without
  re-typing. The per-link revision design above is what makes this possible.
- A cockpit action to delete a shared connection (CLI only for now).
- Align with the draft integration-providers spec (#1613), which generalizes the store to
  `integration-connections/<sha256(root)>/<connectionId>`; shared records would sit beside it
  as `integration-connections/shared/<uuid>`.
