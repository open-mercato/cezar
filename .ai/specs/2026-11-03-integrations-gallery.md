# Settings → Integrations gallery

Status: implemented (2026-11-13). Related: #1614.

## Decision

A project's third-party tools live in ONE project settings section, **Integrations**, shown as a
gallery of tiles grouped by category. A tile shows the tool's status; clicking it opens that
tool's configuration in place (`?integration=<id>`), with **All integrations** to go back.

| Category | Tile id | Configuration it opens |
| --- | --- | --- |
| Issue tracking | `jira`, `linear` | `TrackerSection` limited to that provider |
| Testing | `e2e` | `TesterArmyE2eCard` |
| Webhooks | `slack`, `discord`, `webhooks` | `WebhooksSection` filtered to that tile's format: `slack.v1`, `discord.v1` (notifications only, through the channel's webhook URL) or `cezar.json.v1` |

Several integrations are active at once. The one-tracker-per-project limit of spec 2026-09-18
holds; the Linear/Jira panel warns that connecting the other provider replaces the issue source.

**Why one section:** a separate settings entry per tool (or per category) fragments navigation, and
each new tool would otherwise add a menu item; the same form on two screens would create
competing places to configure it. Each webhook tile's add form is locked to its own destination,
so the receiver form no longer has a destination selector.

## Categories and filter

- Category chips (`All`, `Issue tracking`, `Testing`, `Webhooks`) and the search box filter the
  gallery together. `Webhooks` holds Slack, Discord and the generic endpoints; `Testing` holds
  `TesterArmyE2eCard`. Unavailability never hides a saved integration that needs repair.
- A category is a filter, never part of an integration's identity. A direct link opens the detail
  whatever the filter; going back to the gallery restores the filter, search and focus. Changing
  the category installs, enables and saves nothing.
- A receiver change notice shows only in the tile that owns the receiver. Deleted receivers carry
  no format, so their history stays on the Webhooks tile.

## Relation to earlier specs

Only the settings PLACEMENT of specs 2026-09-18 (Settings → Issue tracker), 2026-10-10
(External integrations → Test frameworks), 2026-10-12 and 2026-10-19 (Settings → Webhooks) moves
here. Their behaviour, storage and APIs are unchanged.

## Addresses and compatibility (released settings paths, v0.19.0)

The address is `/p/:projectId/settings/integrations?integration=<id>` (`integration=e2e` opens
TesterArmy). Released addresses go through the legacy-route resolver without loops or lost
parameters (`endpoint`, `tab`, query/hash, an explicit project, links to a deleted receiver's
history):

- `/settings/tracker` → `/settings/integrations`.
- `/settings/webhooks` → `/settings/integrations`; with `endpoint` it keeps every parameter and adds
  `integration=slack|discord|webhooks` by the receiver's destination (Webhooks when unknown).
- Unscoped `/settings/...` paths go through the same resolver.

An explicitly named project that does not exist gives an unavailable state, never a fallback to
another project. The gallery adds no HTTP route, contract shape or stored state of its own.
