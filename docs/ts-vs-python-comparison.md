# TypeScript vs Python cockpit: size and complexity

Measured on `port-finish` at 4855eb54 (2026-10-30), after the simplification pass. Tools:
cloc 2.10 (code lines exclude blanks and comments) and lizard 1.17 (per-function NLOC and
cyclomatic complexity, CCN). Scripts are not committed; the file lists are described below so
the numbers can be reproduced.

## What is being compared

- **TypeScript app**: `packages/{cezar,web,contract,api-client}/src/**/*.{ts,tsx}`, without
  `*test*`/`*spec*` files and without `packages/web/e2e`. The Tauri shell (`packages/desktop`) is
  out of both counts.
- **Python app**: `app/**/*.py` plus the app's own `static/js` and `static/css`. Vendored
  `datastar.js` and `mermaid.min.js` are excluded, the same way `node_modules` is on the TS side.
- **Tests**: TS `*test*`/`*spec*` files plus `packages/web/e2e`; Python `tests/` plus `e2e/`.

Parity status: `MIGRATION.md` lists 207 rows done and 30 intentionally not ported, with 0 partial
or not done. So these are **not** two copies of the exact same feature set. See the caveats at the
end before reading the ratio as "the same product in 18% of the code".

## Size

| | TypeScript | Python | Python / TS |
| --- | ---: | ---: | ---: |
| Server / engine code | 60,602 (`packages/cezar`) | 29,479 (`app/`, pages included) | — |
| UI code | 72,938 (`packages/web`, React) | 323 (app JS + CSS); HTML is built in `app/features/*/views.py` | — |
| Shared contract + client | 4,746 | — (not needed: one process renders the UI) | — |
| **App total** | **138,286** in 758 files | **29,802** in 159 files | **21.6%** |
| Tests | 164,582 in 858 files | 11,126 in 53 files | 6.8% |
| Direct runtime deps | 37 (`dependencies` across 4 packages) | 4 (`stario`, `litewriter`, `cryptography`, `pyyaml`) | |
| Lockfile packages | 672 (`package-lock.json`) | 22 (`uv.lock`) | |

## Complexity (lizard)

| | TS server | TS web | TS total | Python app |
| --- | ---: | ---: | ---: | ---: |
| Functions | 4,974 | 6,618 | 11,592 | 1,797 |
| Code lines inside functions | 40,278 | 50,403 | 90,681 | 25,743 |
| Total CCN | 16,967 | 16,766 | 33,733 | 8,831 (26% of TS) |
| Mean CCN per function | 3.41 | 2.53 | 2.91 | 4.91 |
| 95th percentile CCN | 11 | 8 | — | 15 |
| Functions with CCN > 15 | 137 | 82 | 219 | 80 |
| Functions with CCN > 30 | 25 | 11 | 36 | 8 |
| Highest CCN | 176 | 98 | 176 | 58 |
| Functions over 100 lines | 15 | 21 | 36 | 5 |

How to read this: the Python port has about a quarter of the decision points, but they are
packed into fewer, larger functions (mean CCN 4.9 vs 2.9). React splits UI into many tiny
components and hooks, which lowers the TS mean. The worst functions are worse on the TS side
(176 vs 58), and Python has fewer very large ones.

The remaining Python hotspots are wire-format parsers for the agent CLIs (`parse_claude_line` and
the others in `app/engine/runners/protocol.py`), form and schema validators, and `_stream_turn` in
the engine. The simplification pass left them as they are because splitting them only added lines.

## Why the gap is this large

What really reduces the code:

1. **No client/server split.** Pages are rendered on the server and patched over SSE (Datastar),
   so there is no React state, no fetch layer, no shared `contract` types, and no JSON API that
   exists only to feed the UI. That accounts for most of the 73k UI lines and much of the TS
   server's route code.
2. **SQLite + `db.watch`** in place of `runs.json` + NDJSON + a WebSocket bus for invalidation.
3. **Python stdlib + 4 dependencies** in place of a 672-package tree.

What makes the ratio flatter than it really is (it favours Python):

1. **30 rows were deliberately not ported**: the desktop shell, self-update, telemetry sending,
   star count, skills auto-update, the WebSocket bus, and about a dozen SPA-only JSON families.
   Their TS code is still counted above. I don't have a line-accurate subtraction. A fair rough
   range for the Python share of the *comparable* TS code is **25–30%**, not 22%.
2. **UX depth differs.** The React app has a command palette, drag layouts, per-surface drafts,
   virtualised and resizable panes, and many polished empty and loading states. The Datastar
   pages are functional but plain, with hand-written CSS of about 250 lines. Feature parity is
   not visual parity.
3. **Tests are not comparable.** Python has 6.8% of the TS test code and 14 browser walks
   against 43. TypeScript's suite pins far more edge cases. Every runner (claude, codex, ...) is
   checked only against fake CLIs on the Python side.

What makes it steeper than it should be (it disfavours Python):

1. The Python app still carries the TS JSON API (`app/features/api/`, about 4.5k lines) for
   parity. Pages hardly use it. `docs/python-trim-proposal.md` shows cutting it to what the CLI
   needs, which would bring the app to about 24k lines but would give up JSON-API parity.

## Simplification pass (this branch)

| Step | `app/` raw lines | Change |
| --- | ---: | --- |
| After the migration | 35,315 | |
| S1: drop Python-only extras (inbound hooks, `CEZ_REAL_AGENTS`) and dead code | 34,878 | −437 |
| S2: dedupe page handlers, API bodies, `gh` wrapper, receivers (pylint duplicates 23→7) | 34,576 | −302 |
| S3: complexity hotspots (`_agent_step` CCN 76→22, `_graph_walk`, parsers, task view) | 34,519 | −57 |

Behaviour changes the pass allowed, none of them pinned by a test:

- A few error replies are different: a bad task id on `…/live` is now 404 instead of 400; a bad
  JSON body on a live stream reads "invalid input"; with several invalid fields, a different one
  may be reported first.
- The key order in the run JSON record changed.
- `gh` reads time out after 30s instead of 15s.

Security controls are unchanged: the loopback host guard, Basic auth when hosted, AES-GCM
secrets with audiences, secret-free checks for untrusted PR heads, and sha/path/id validation.
