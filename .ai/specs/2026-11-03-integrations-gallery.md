# Settings → Integrations gallery

Status: implemented (stacked on PR #1914). Related: #1614, PR #1613.

## Decision

A project's third-party tools live in ONE settings section, **Integrations**, shown as a gallery of
tiles grouped by category. A tile shows the tool's status; clicking it opens that tool's existing
configuration in place (`?integration=<id>`), with **All integrations** to go back.

| Category | Tile id | Configuration it opens |
| --- | --- | --- |
| Issue tracking | `jira`, `linear` | `TrackerSection` limited to that provider |
| Testing | `e2e` | `TesterArmyE2eCard` |
| Notifications | `slack`, `discord`, `webhooks` | `WebhooksSection` filtered to `slack.v1` / `discord.v1` / `cezar.json.v1` |
| Notifications | `telegram` | the Telegram panel and wizard from spec 2026-10-29 |

Several integrations are active at once. The one-tracker-per-project limit of spec 2026-09-18 is
unchanged; the Linear/Jira panel warns that connecting the other provider replaces the issue source.

## Supersedes

Only the settings PLACEMENT in: 2026-09-18 (Settings → Issue tracker), 2026-10-10 (External
integrations → Test frameworks), 2026-10-12, 2026-10-19 Slack/Discord (Settings → Webhooks) and
2026-10-29 (External integrations → Telegram tab). Their behaviour, storage and APIs are unchanged.

## Compatibility

- `/settings/tracker` → `/settings/integrations`.
- `/settings/webhooks` → `/settings/integrations`; with `endpoint` it keeps every parameter and adds
  `integration=slack|discord|webhooks` by the receiver's destination (Webhooks when unknown).
- No new routes, contract shapes or stored state.
