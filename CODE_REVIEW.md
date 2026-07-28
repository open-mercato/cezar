# Code review rules

How to review a diff in this repository. Applies to humans and to the `om-code-review` skill alike. The full validation gate in `.ai/agentic.config.json` must be green before a review verdict is meaningful: typecheck, the vitest unit/component suites (`npm test`), the node:test core-module suite (`npm run test:unit`), build (which includes the `check:pack` tarball gate), and the packaged CLI E2E (`npm run test:package`). The unit/component suites are the fast correctness gate; real-browser E2E (`npm run test:e2e`) remains the QA layer for user-facing changes.

## Review priorities (in order)

1. **Correctness of the run lifecycle** — runs, steps, worktrees, sessions. A bug here loses user work.
2. **Graceful degradation** — the README's core promise: no `gh` → works without PRs, no network → local skills still load, no git repo → tasks run in place, `CEZ_DRY_RUN=1` → everything works offline. A diff that turns a degradation path into an error is a blocker.
3. **State-file compatibility** — `.ai/cezar/` files outlive the process and the version that wrote them (see `BACKWARD_COMPATIBILITY.md`).
4. **Security of the local server** — it binds to `127.0.0.1`, but it executes agents with file access; treat every request body as hostile.
5. **Simplicity** — "every module is meant to be read in one sitting." Push back on new dependencies or abstractions the change doesn't need; browser dependencies must justify their bundle and maintenance cost.

## Checklist

### TypeScript strictness

- `tsconfig.json` has `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` — the diff must compile without weakening them.
- No `any`, no non-null assertions to silence the checker; prefer narrowing, `unknown` + zod, or explicit optional handling. Indexed access is checked — `arr[0]` is `T | undefined`, handle it.
- ESM with NodeNext resolution: relative imports carry the `.js` extension even in `.ts` files. `node:`-prefixed builtins.

### Zod at every boundary

- Every mutating API route parses its body with `schema.safeParse(await c.req.json().catch(() => null))` and returns `{ error: issues.join('; ') }` with 400 on failure — the established pattern in `packages/cezar/src/server/server.ts`. New routes must follow it; a route that trusts `c.req.json()` raw is a blocker.
- External process output crossing into the app (`gh … --json` in `packages/cezar/src/server/github.ts`, agent CLI streams) is zod-validated at the boundary, extras stripped.
- Persisted files read back in (`runs.json`, `config.json`, workflow YAML) go through their schema; parse failure degrades to a sane default, never a crash.
- Schemas carry the limits (`.max()` on strings/arrays, image size caps, `variants` 1–3, steps ≤ 8). New inputs need explicit bounds — unbounded user input into a file write or a spawned process is a blocker.

### Graceful degradation

- Missing `gh` / no remote / offline: GitHub reads return `{ available: false, reason }`, PR creation returns `{ ok: false, error }` — never a throw, never a 500 for an expected absence.
- Missing or malformed `.ai/cezar/config.json` behaves exactly like the defaults and never blocks startup (`packages/cezar/src/config.ts`).
- git helpers in `packages/cezar/src/git-worktree.ts` never throw (except `createWorktree`); check the diff keeps that contract.
- `CEZ_DRY_RUN=1` paths must still work after the change — that is the offline demo and the de-facto integration test.

### Security

- No secrets in state files: nothing under `.ai/cezar/` (runs.json, NDJSON events, handoff.md, ui-state.json, config.json) may contain tokens or credentials. `GITHUB_TOKEN` stays in the environment; the launch key stays in the gitignored `launch-key` file and is only served same-origin.
- Server stays on `127.0.0.1`; CORS is for `/api/health` only (bookmarklet discovery, spec 011). Widening either is a blocker.
- Path handling on user-supplied names: file-serving routes must sanitize (`basename()` as in `/api/runs/:id/images/:file`); workflow names are slugified before becoming filenames. Any user string that reaches a path or a shell needs the same treatment.
- Spawned processes use `execFile`/`spawn` with argument arrays — never string-interpolated shell commands. Tool access for agents goes through a per-step allowlist (`allowedTools`), but the zero-config default includes unrestricted `Bash` (no `bashAllowlist`), and unapproved tools are denied without prompting (`--permission-mode dontAsk`; `CEZ_APPROVAL_GATE=1` opts into `acceptEdits` and Claude's approval UI) — treat a run as having full shell access in its worktree, not a sandboxed allowlist. Codex and OpenCode don't honor `allowedTools` at all (Codex: its own sandbox, approvals off, network on; OpenCode: everything auto-approved) (#430).
- Writes that must not clobber use `wx` or tmp+rename; check new file writes follow one of those.

### State-file and API compatibility

- New fields on `RunRecord`/`StepState` are optional (or defaulted) so old `runs.json` files still parse — the existing comments ("old runs.json files … have neither") show the convention.
- NDJSON event logs are append-only; readers skip unparseable lines. Never rewrite or reorder an existing event file.
- Renaming/removing an API route, an event `type`, or a persisted field is a breaking change — route it through `BACKWARD_COMPATIBILITY.md`.

### Code quality

- Comments cite the spec or issue that motivated the code (`spec 006`, `#348`); non-obvious behavior in the diff should too.
- No new **server runtime** dependencies without strong justification — that dependency budget is hono, @hono/node-server, yaml, zod, smol-toml and ws, and nothing else. The list is exhaustive on purpose: adding to it is a review decision, so the commit that widens it updates this line and says why. (`ws` earned its place because Node ships a WebSocket *client* but no server and `@hono/node-server` provides none, so the `/api/ws` subscription bus had no in-tree option — spec `.ai/specs/2026-07-23-websocket-subscriptions.md`.) Browser packages are build-time dependencies and must remain locked, bundle-measured, and absent from the installed CLI's runtime dependency graph.
- Web UI changes belong under `packages/web/` and follow the accepted React 19 + Vite + Tailwind v4 + shadcn/ui architecture. Keep `packages/cezar/web/dist` reproducible from source, preserve light/dark/system themes and mobile/accessibility behavior, and add unit/component tests for changed behavior. (The legacy vanilla UI was retired in R7; the React cockpit is the only UI, and `/new` is the React composer.)
- User-facing errors are one human-readable line (the `createDraftPr` pattern), not stack traces.

## Severity guidance

- **Blocker** (request changes): data loss or corruption in `.ai/cezar/`; a degradation path turned into a hard failure; unvalidated request body on a mutating route; secret written to disk; server exposed beyond localhost or CORS widened; path traversal; breaking a surface in `BACKWARD_COMPATIBILITY.md` without the required path; typecheck/build red.
- **Major** (request changes unless trivially fixed in-review): incorrect run/step state transitions; SSE replay duplication or event loss; unbounded input reaching files or processes; a schema field added as required when old files carry it as absent.
- **Minor** (approve with comments): missing spec citation on non-obvious code; inconsistent error shape; naming/style drift; missed `wx`/tmp+rename on a low-stakes write.
- **Nit**: wording, formatting, comment polish. Never blocks.

Verdict: approve when there are no blockers or majors; otherwise request changes with each finding tagged by severity and file/line.
