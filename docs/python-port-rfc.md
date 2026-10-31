# RFC: a Python/Stario cockpit next to the TypeScript one

**This is a discussion PR, not a request to switch.** It adds a working Python port of the
cockpit next to the TypeScript tree (the TypeScript code is not changed), so the two can be
compared on real code instead of on opinion. If the conversation goes nowhere, closing it costs
nothing.

## What is in this PR

- `app/`, `static/`, `tests/`, `e2e/`: a Python 3.14 cockpit on [Stario](https://github.com/stariodev/stario)
  (HTTP + SSE), [Datastar](https://data-star.dev) (hypermedia in the browser) and SQLite through
  [litewriter](https://github.com/Bobowski/litewriter).
- `MIGRATION.md`: a row-by-row parity checklist against the TypeScript source, with 237 rows:
  **207 done, 30 intentionally not ported, 0 partial, 0 not done**. Each row names the test that
  verifies it and the TypeScript file it was ported from.
- `docs/ts-vs-python-comparison.md`: measured size and complexity, with the caveats.
- `docs/python-trim-proposal.md`: what could still be cut.
- `pyproject.toml`, `uv.lock`, `Dockerfile`, `compose.yaml`, `justfile`, `.github/workflows/python.yml`
  (runs only when Python paths change).
- `AGENTS.md` gets a short section, and `.cursor/skills/` gets the Stario skills agents follow when
  editing `app/`.

Run it: `uv sync && CEZ_DRY_RUN=1 uv run python -m app.main` → `http://127.0.0.1:4321`.

## The numbers

| | TypeScript | Python |
| --- | ---: | ---: |
| App code (cloc, no tests) | 138,286 lines / 758 files | 29,802 lines / 159 files (**21.6%**) |
| Total cyclomatic complexity (lizard) | 33,733 | 8,831 (**26%**) |
| Worst function (CCN) | 176 | 58 |
| Functions over 100 lines | 36 | 5 |
| Lockfile packages | 672 | 22 |
| Direct runtime dependencies | 37 | 4 |

The honest adjustment: 30 TypeScript features were deliberately left out (desktop shell,
self-update, telemetry sending, the WebSocket bus, SPA-only JSON families), and the React UI is
far more polished. On *comparable* code the Python share is roughly **25–30%**, not 22%. Python
also has much less test code (11k lines vs 165k), and the agent CLIs are tested only against fakes.
`docs/ts-vs-python-comparison.md` has the full breakdown.

## Why the difference is so large: the architecture, in short

**TypeScript today: an API server plus a SPA.** Hono serves about 190 JSON routes and a
WebSocket bus. A React app (React Query, React Router, Radix, xyflow, xterm, ...) fetches those
routes, caches the results, and invalidates the cache when a WebSocket topic fires. A shared `zod`
contract package describes every payload, and state lives in `runs.json` plus NDJSON files under
lockfiles. Every feature is written **three times**: as a server handler that serialises, as a
contract schema, and as a client fetch/hook/cache plus the component that renders it.

**Python: one process, hypermedia, commands and queries split (CQRS-shaped).**

```
browser ── POST /tasks/{id}/approve ──► command: validate, write SQLite, reply empty
   ▲                                              │ commit
   │                                              ▼
   └── SSE GET /tasks/{id}/live ◄── query: db.watch fires → re-render the page's HTML on the server
                                        Datastar morphs it into the DOM
```

- **Commands only write.** A `POST` validates, writes to SQLite and returns nothing.
- **Queries only read.** Each page has one `…/live` stream. When the database commits, the server
  re-renders that page's HTML and Datastar (a ~33 KB script) patches the DOM.
- **No client state at all.** There is no API contract to keep in sync, no cache to invalidate,
  and no WebSocket protocol.
- **SQLite transactions** replace JSON files, lockfiles and partial-write recovery.

Where the lines go, measured on the TypeScript side:

| TypeScript layer | Code lines | Python equivalent |
| --- | ---: | --- |
| `web/src/routes` + `components` (React screens) | 59,628 | `app/features/` is 10,055 in total, including about 4.5k of TS-parity JSON API; HTML is built server-side and is much plainer |
| `web/src/api` + `lib` (fetch, cache, client helpers) | 12,703 | none needed |
| `contract/src` (zod payload schemas) | 4,324 | none needed |
| `cezar/src/server` (HTTP + WS layer, `server.ts` alone is 8.4k raw lines) | 14,716 | `handlers.py` per page; JSON kept only where parity needs it |
| Engine: `workflows`, `runs`, `core` | 23,894 | `app/engine/` 11,756 + `app/integrations/` 5,143 |

The engine shrinks the least, and that is expected: agent wire protocols, git, worktrees and
workflow semantics are essential complexity, and they are the same in both languages. The big
saving is the **accidental** complexity of keeping a second application (the SPA) in sync with
the first.

## What it costs, stated plainly

- **UX.** Server-rendered pages are functional but plain. Rich interactions (drag and drop,
  command palette polish, virtualised panes) need small hand-written JS islands (`static/js/`),
  not a component library.
- **Latency model.** Each interaction is a round trip to a local server. For a loopback cockpit
  that is sub-millisecond, but an offline or optimistic UI is not free.
- **Language and ecosystem.** Agents and contributors work in Python instead of TypeScript. The
  desktop shell (Tauri) would need to launch a Python process.
- **Maturity.** The TypeScript suite and real-world use pin far more edge cases.

## If we pursued the architecture fully: the next simplifications

These are design-level choices, not cleanups. Each one would give up some 1:1 parity with the
TypeScript behaviour, which is why this PR does not make them.

1. **The JSON API becomes the CLI's API only.** The pages don't use it. Keeping the ~15 routes
   that `cez` and the agents call removes about 3.5k app lines and 3k test lines.
2. **One live mechanism.** Pages currently stream from two sources: a relay "changed" ping (8
   features) and `db.watch` (1 feature). Making every page follow `db.watch` deletes the relay
   plumbing and the "remember to publish" bugs.
3. **Event-sourced runs.** The `events` table is already the transcript. Making it the source of
   truth, with the run row as a projection, removes most of the hand-kept status bookkeeping in
   the engine (about 3k lines, the largest module) and makes restart recovery a replay instead of
   special cases.
4. **One workflow executor.** Linear `steps` workflows and v2 graphs have separate walkers
   (`_walk`, `_graph_walk`). Compiling linear workflows to a graph leaves one executor.
5. **Settings in SQLite.** About 35 side files (`agent-defaults.json`, `composer-defaults.json`,
   `ui-state.json`, ...) become one typed settings table. That gives one read path, one write path
   and live updates for free.
6. **The webhook outbox as a table.** The NDJSON outbox with sequence numbers becomes a SQLite
   table drained on `db.watch`.
7. **Runner protocols as data.** The per-CLI line parsers (the remaining complexity hotspots) become
   mapping tables from wire event to transcript event.
8. **Tests at the HTTP/SSE boundary.** A command plus the next SSE frame is a complete UI test
   without a browser. Browser walks are then needed only for the JS islands.

Rough outcome: about **20k lines** of Python for the same product. The engine would be the
main remaining cost, as it should be.

## How this was built

The port was done in stream branches on a fork, followed by a finishing pass and a simplification
pass. Every pass was checked by the test suite before landing. Each `MIGRATION.md` row says what
verified it, and nothing is marked done without a test or a manual run.

## Asks

- Is a hypermedia/CQRS cockpit worth a deeper look, for example as a spike on one area such as
  the task page?
- Are the "intentionally not ported" rows the right ones?
- Which of the next simplifications would be acceptable as product changes?
