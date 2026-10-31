# Python port: trim proposal

Status: proposal, not applied. Measured on `port-finish` at 69303c94, before the simplification pass (S1 already removed cut 3; see `docs/ts-vs-python-comparison.md` for current numbers).

The Python `app/` is 35.3k raw lines. The pages (Datastar screens) depend on almost none of the
`/api/v1` JSON layer: apart from `/api/v1/health` and the PR merge button, no view or script in
`app/features/*` or `static/js` calls it. The JSON layer exists because the port first mirrored the
React SPA's API. Under Stario's split (pages read on the server, commands write, `…/live` streams),
most of it has no consumer left.

Who still needs JSON:

| Consumer | Routes it calls |
| --- | --- |
| `cez` CLI (`app/cli_commands.py`) | `GET /runs`, `POST /runs/{id}/dispatch`, `POST /runs/{id}/report`, the `/automations` family, `deferred-start` preview/create |
| Agents inside a run | the same `cez task create` / report routes (through the CLI) |
| Docker healthcheck and discovery | `GET /health`, `GET /api/v1/health` |
| Task page | `POST /api/v1/github/prs/{n}/merge` |
| Outside callers you rely on (unknown to me) | **you decide** — anything listed here stays |

## Proposed cuts, biggest first

| # | Cut | What goes | Est. lines (app + tests) | Functionality lost |
| --- | --- | --- | --- | --- |
| 1 | JSON routes with no consumer | Of 81 `/api/v1` routes, keep the ~15 above. Drop the rest of `app/features/api/{surface,families,closeout,handlers}.py` (5.3k lines today) and the tests that only pin those payloads | ~3.5k app, ~3k tests | None in the UI or CLI. Third-party scripts written against the TS JSON API would break. |
| 2 | Webhook control-plane JSON (PR #11) | The 19 `/webhooks/*` JSON routes and `integrations/registry.py`, most of `service.py`, `history.py`. Keep delivery, formats (`webhook_schema.py`, `discord_render.py`, `outbox.py`) and the `/settings/webhooks` page | ~1.2k app, ~250 tests | Pause/resume/rotate/replay from a JSON client. Add them as commands on `/settings/webhooks` if you want them (~150 lines). |
| 3 | Inbound `/hooks/github`, `/hooks/jira`, `/hooks/linear` + receipts | `integrations/hooks.py` inbound part | ~350 app, tests | None. This was a Python-only addition; the pollers now cover triggers, as in TS. A loopback cockpit rarely receives webhooks anyway. |
| 4 | Telemetry consent store and routes | `engine/telemetry_store.py`, `/telemetry/*` routes | ~150 | None. Nothing is ever sent. |
| 5 | SPA UI-state files | `/workspace/ui-state`, workspace drafts, layouts, prompt-templates file routes (`engine/ui_state.py`) | ~250 | None. Datastar keeps it in page signals. |
| 6 | Second event stream for JSON clients | `GET /api/v1/events`, `/workspace/events`, `/runs/{id}/events` SSE (pages use their own `…/live`) | ~200 | JSON clients lose a live feed; `cez` does not use it. |
| 7 | Stored-but-unread settings | `askSkill` (no Ask mode), `defaultModelsAuto` (same as empty) | ~40 | None today. |

Total: about **5.5–6k lines of app code (~16%) and a similar amount of tests**, with no lost screen
or CLI behaviour.

## Not cuts, but worth doing after

- `app/engine/engine.py` is 3,078 lines; MIGRATION.md already flags it as several resources in one
  class. Splitting it (walk, recovery, scheduling, git landing) shrinks nothing but makes later trims
  safe.
- Settings code is spread over `features/settings`, `features/editors` and `features/places`
  (accounts moved to `editors` in batch 5). One `settings` feature per URL noun would match the
  Stario layout.
- The full TypeScript tree (`packages/`, ~138k app lines) is still in the repo next to the port. If
  the Python cockpit is now the product on this fork, removing it is the largest trim by far. That is
  a product decision, not a code one.

## Order if approved

1 and 6 together (one PR: "JSON API = CLI + health"), then 2, then 3–5, then 7. Each is a sequential
worker batch with the full suite and e2e run before commit, same as the migration.
