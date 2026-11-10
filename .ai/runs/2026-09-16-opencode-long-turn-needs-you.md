# Execution plan — OpenCode turns over five minutes must not park the run under "Needs you"

- Issue: [#897](https://github.com/open-mercato/cezar/issues/897)
- Branch: `fix/opencode-long-turn-needs-you`
- Engine: om-auto-create-pr (steps: 9, --loop: no)

## Goal

An OpenCode turn that is still executing tools after five minutes stays `running`. Today it ends
with `opencode: prompt failed: fetch failed` at exactly 5:00 and the cockpit parks the run under
"Needs you" while the OpenCode session keeps streaming SSE and tool events.

## Root cause

`OpencodeSession.prompt()` awaits `POST /session/:id/message`. OpenCode holds that request open for
the whole agent turn (tools, CI watches, long commands). Node's global `fetch` is undici, whose
default `headersTimeout` / `bodyTimeout` is **300 000 ms**, so the request throws
`TypeError: fetch failed` at 5:00 sharp. Two consequences, both wrong:

1. `prompt()`'s `finally` emits `turn-end` regardless — `workflows/run.ts` reads that as "the agent
   stopped talking" and moves the run to `waiting`. The reporter measured four consecutive turns on
   one run each dropping at exactly 5:00, with SSE/tool events still flowing afterwards.
2. On **Continue**, `bootstrap()` does an un-caught `await this.prompt(first)`, so the same drop
   rejects `ready`, surfaces as a fatal `{ type: 'error' }`, and `runContinuation` answers with
   `interrupt()` — SIGTERM/SIGKILL on a session SSE still shows as working. Three Continues in the
   reported run failed at ~300.6 s each.

The same 300 s inactivity cut applies to the `GET /event` SSE response body, so a quiet session can
lose its event stream too — which matters once the turn boundary depends on it.

The v1 stream is also the only place that still synthesizes `turn-end` from the HTTP response. The
v2 mapper in the same directory already takes `turn.completed` from the wire `session.idle`, and the
bundled mock server exists precisely to pin the ordering quirk that makes the HTTP response the
wrong boundary (the response resolves *before* the final text part).

## Scope

- `packages/cezar/src/core/opencode-server-runner.ts`
- new `packages/cezar/src/core/opencode-http.ts` (+ its test)
- `packages/cezar/src/core/opencode-server-runner.test.ts`
- `packages/cezar/src/core/__fixtures__/opencode/mock-opencode-serve.mjs`
- a stale comment in `packages/cezar/src/core/opencode-ui-mapper.test.ts`

## Non-goals

- The 30-minute agent-step wall clock (#880) stays exactly as it is — a separate, configurable
  control. Nothing in this change touches `spec.timeoutMs` or the deadline it arms.
- `workflows/run.ts` turn-end semantics are not touched. A `turn-end` still means what it always
  meant; this change only stops emitting one that never happened.
- The Codex runner, automations, server-install, forge and `packages/web` are out of scope.
- The v2 `UiEvent` stream is already correct here and keeps its current output.

## Design

**Transport (Phase 1).** Move the runner's HTTP off global `fetch`/undici onto `node:http`, which
applies no client-side header or body timeout by default. `undici` is not a dependency of
`@open-mercato/cezar` and adding one to set `headersTimeout: 0` would be a new runtime dependency
for a request the platform can already make. Both the long-poll message POST and the SSE
subscription go through the new helper, because the fix makes `session.idle` load-bearing and an SSE
stream that itself dies after 300 s of quiet would take the turn boundary with it.

**Turn boundary (Phase 2).** `turn-end` comes from the wire `session.idle` for our session — the
same signal v2 already uses — instead of the HTTP response. Three properties have to hold for this
not to become a state with no exit (AGENTS.md: *enumerate the transitions out of every state you
add or keep*). A turn therefore also ends when:

- the POST settles and the SSE subscription never connected at all (legacy fallback: the old
  behaviour, for a server that speaks no event bus);
- the POST has settled and neither `session.idle` nor any SSE frame for our session has arrived
  within a short grace window — an OpenCode build that does not emit `session.idle` still gets a
  turn-end, and a session that is genuinely working keeps re-arming the window;
- the session tears down (`end()`, `interrupt()`, the server process exiting, or the SSE stream
  closing) — an in-flight turn is settled there rather than left open.

A POST that fails on transport while the session is still live emits neither `turn-end` nor the
`prompt failed` note; it is not evidence of anything. A non-2xx HTTP status is unchanged — a real
error, surfaced as before.

## Risks

- **A turn that never ends.** Mitigated by the three fallbacks above, each with its own test.
- **`node:http` instead of `fetch`.** A smaller, older API; the helper is deliberately tiny and
  covered by its own unit test, including the abort and non-2xx paths.
- **Turn-end now lands after the last SSE part instead of before it.** That is the intended
  correction (it is why the mock exists), and it means `run.ts` reads end-of-turn markers from the
  complete text rather than a truncated one.

## Implementation Plan

### Phase 1: timeout-free transport

- 1.1 Add `opencode-http.ts`: a `node:http` JSON request and an SSE frame stream, neither subject to
  a client-side header/body timeout, both abortable via `AbortSignal`.
- 1.2 Unit-test the helper: a response whose body arrives long after undici's 300 s cut still
  resolves; non-2xx surfaces the status; abort rejects; SSE frames are split on the blank line.
- 1.3 Point `OpencodeSession.http()` and `consumeEvents()` at the helper.

### Phase 2: the turn boundary is `session.idle`

- 2.1 Extend the bundled mock server with a scripted long-turn mode: drop the message POST
  mid-turn, keep streaming SSE, then send `session.idle`.
- 2.2 End the turn on `session.idle`, with the settled-POST/no-activity grace, the no-SSE legacy
  fallback and teardown settlement.
- 2.3 Stop treating a transport-level POST failure on a live session as a turn end: no `turn-end`,
  no `prompt failed` note, and no fatal `error` out of `bootstrap()` (the Continue path).

### Phase 3: tests and gate

- 3.1 Regression tests: the over-five-minute turn stays running and ends on `session.idle`; the
  short turn is unchanged; a dropped first prompt does not kill a Continue; the no-`session.idle`
  and no-SSE fallbacks still reach `turn-end`.
- 3.2 Run the full validation gate and refresh the now-stale v1 comments in
  `opencode-ui-mapper.test.ts`.

## Progress

PR: #1005

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: timeout-free transport

- [x] 1.1 Add the `opencode-http.ts` node:http request/SSE helper — d6de031b
- [x] 1.2 Unit-test the transport helper — fce8e56f
- [x] 1.3 Point the runner's HTTP and SSE at the helper — d6de031b

### Phase 2: the turn boundary is `session.idle`

- [x] 2.1 Teach the bundled mock server a long-turn (dropped POST) mode — fce8e56f
- [x] 2.2 End the turn on `session.idle` with bounded fallbacks — d6de031b
- [x] 2.3 A transport failure on a live session is neither a turn end nor a fatal error — d6de031b

### Phase 4: review pass (om-auto-review-pr)

- [x] 4.1 A superseded turn settles instead of hanging its own `prompt()` — 5785aa62
- [x] 4.2 A drop on a turn that never reaches `session.idle` is still reported — 5785aa62

### Phase 3: tests and gate

- [x] 3.1 Regression tests for the long turn, the short turn and the fallbacks — fce8e56f
- [x] 3.2 Full validation gate and comment refresh — dfcc26f7
