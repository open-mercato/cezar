# Settings → Integrations gallery

Status: implemented (2026-11-13). Related: #1614, spec 2026-10-29 (Telegram), spec 2026-11-05
(extension system: Settings → Extensions), spec 2026-11-09 (independent chat plugins).

## Decision

A project's third-party tools live in ONE project settings section, **Integrations**, shown as a
gallery of tiles grouped by category. A tile shows the tool's status; clicking it opens that
tool's configuration in place (`?integration=<id>`), with **All integrations** to go back.

| Category | Tile id | Configuration it opens |
| --- | --- | --- |
| Chat | `telegram` and every extension chat provider | the provider's panel and setup wizard (spec 2026-10-29, spec 2026-11-04-chat-providers) |
| Issue tracking | `jira`, `linear` | `TrackerSection` limited to that provider |
| Testing | `e2e` | `TesterArmyE2eCard` |
| Webhooks | `slack`, `discord`, `webhooks` | `WebhooksSection` filtered to that tile's format: `slack.v1`, `discord.v1` (notifications only, through the channel's webhook URL) or `cezar.json.v1` |

Several integrations are active at once. The one-tracker-per-project limit of spec 2026-09-18
holds; the Linear/Jira panel warns that connecting the other provider replaces the issue source.

**Why one section:** a separate settings entry per tool (or per category) fragments navigation, and
each new chat provider would otherwise add a menu item; the same form on two screens would create
competing places to configure it. Each webhook tile's add form is locked to its own destination,
so the receiver form no longer has a destination selector. Installing software is a different
concern and lives in Settings → Extensions; Integrations configures a connection for one project.

## Settings → Extensions and Settings → Integrations

| Place | Scope | Content and actions |
| --- | --- | --- |
| Settings → Extensions | Global catalog of installed and shipped packages; approval is always for a named project | Source, version, permissions, compatibility, update, enable/disable for a project, uninstall. Telegram and an installed Mattermost are ordinary entries. |
| Settings → Integrations | One project, named in the header and the URL | The gallery with categories. A service's detail: setup, state, receivers, history, pairing, grants and disconnect. |

- Package state, its approval in a project, connection state and person/chat permissions are
  separate: `Installed` means neither `Connected` nor permission to run tasks. One provider view
  holds its bots and receivers whatever the artifact's source.
- Shipped packages are labelled "Shipped with Cezar"; an external version's origin is visible.
- An extension's detail in Extensions links "Manage <provider> connection" to the Integrations form
  of the named project; Integrations links "Manage extension" back. The `extension=<extensionId>`
  and `project=<projectId>` parameters only choose the view; every operation is validated by the
  host. Secrets never go into a URL.
- Connections stay visible after disable, uninstall, a failure or a missing package, with the cause
  and a repair action, without starting a worker just to render the screen.
- `Disable extension`, `Disconnect` and revoking a person's or chat's grant are different
  operations. Removal or update shows the affected projects and the effect. Opening the catalog
  does not install, enable or query the npm registry.
- Switching the project clears the form's draft and context; a refetch of the same project's
  metadata does not reset an active pairing.
- Panels, forms and commands of other extensions keep their placements
  (`2026-11-07-extension-placements.md`).

## Categories and filter

- Category chips (`All`, `Chat`, `Issue tracking`, `Testing`, `Webhooks`) and the search box filter
  the gallery together. `Chat` covers Telegram and extension providers (e.g. Mattermost);
  `Webhooks` holds Slack, Discord and the generic endpoints; `Testing` holds `TesterArmyE2eCard`.
  Unavailability never hides a saved integration that needs repair. A new extension never adds a
  settings menu entry.
- A category is a filter, never part of an integration's identity. A direct link opens the detail
  whatever the filter; going back to the gallery restores the filter, search and focus. Changing
  the category installs, enables and saves nothing.

## Relation to earlier specs

Only the settings PLACEMENT of specs 2026-09-18 (Settings → Issue tracker), 2026-10-10
(External integrations → Test frameworks), 2026-10-12 and 2026-10-19 (Settings → Webhooks) moves
here. Their behaviour, storage and APIs are unchanged.

## Addresses and compatibility (released settings paths, v0.19.0)

The addresses are `/settings/global/extensions` and
`/p/:projectId/settings/integrations?integration=<providerId>` (`integration=e2e` opens
TesterArmy). Released addresses go through the legacy-route resolver without loops or lost
parameters (`endpoint`, `tab`, query/hash, an explicit project, links to a deleted receiver's
history):

- `/settings/tracker` → `/settings/integrations`.
- `/settings/webhooks` → `/settings/integrations`; with `endpoint` it keeps every parameter and adds
  `integration=slack|discord|webhooks` by the receiver's destination (Webhooks when unknown).
- Unscoped `/settings/...` paths go through the same resolver.

An explicitly named project that does not exist gives an unavailable state, never a fallback to
another project. The gallery adds no HTTP route, contract shape or stored state of its own.
