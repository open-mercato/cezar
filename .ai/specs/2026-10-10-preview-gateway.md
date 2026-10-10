# The preview gateway — a task's app, from a cockpit that is not on the task's machine

> Status: implemented (2026-10-10), opt-in. The gateway, its route and the Browser column are
> covered by the suite; the nginx wiring in `docs/server-install/ubuntu-vps.md` has NOT been run
> on a live VPS, and the installer does not set it up.
> Implementation: `packages/cezar/src/server/preview/gateway.ts`,
> `POST /api/v1/preview/gateway` in `server/server.ts`, `packages/web/src/routes/task-workspace/browser-view.tsx`.
> Supersedes the gap recorded in `2026-10-07-task-workspace.md` §7 ("the preview PROXY is
> deliberately not built"). That section's refusal — no proxy on the cockpit's origin — stands.

## 1. Problem

A local cockpit frames `http://localhost:3000` and shows the task's app, because the browser
and the task share a machine. A hosted cockpit cannot: there the address is the VIEWER's
machine. The Browser column refuses it, so on a VPS a task's app cannot be looked at from
cezar at all. The same is true of any cezar that is not bound to loopback — including one
running in a container on the viewer's own computer.

## 2. Why the obvious proxy is wrong, and what is built instead

Serving the app under the cockpit's own address (`/preview/3000/…`) would put worktree-served
content on the cockpit's ORIGIN. The front's login is ambient there — the browser attaches it
to every same-origin request — so any script in the previewed app could drive the cockpit's
API: start tasks, write files, open a shell where those are enabled. §7 of the workspace spec
refused that, and an opaque-origin sandbox is not a way out: it breaks the same-origin fetches,
cookies and storage that every real app uses.

A different origin needs a different scheme, hostname or port. A hostname per app means
wildcard DNS and a wildcard certificate — configuration a user has to author. A **port** per
app needs neither: same hostname, same certificate, and still a different origin.

So: the operator names a pool of ports. cezar re-serves each previewed app on one of them.

## 3. Behaviour

- `CEZ_PREVIEW_PORTS` (a range, a list, or both) names the pool. Unset, there is no gateway and
  nothing listens. The gateway binds the same interface as cezar.
- `CEZ_PREVIEW_PUBLIC_PORTS`, optional, names the port a browser reaches each pool port at,
  position for position. Needed when the front runs on the same host and so cannot bind the
  same number; absent, the numbers are the same (a container's published ports).
- On a cockpit where `capabilities.preview` is false, the Browser column sends a loopback
  address to `POST /api/v1/preview/gateway` instead of framing it, and frames the answer. It
  never frames the address as typed. With no gateway the route answers 409 and the column shows
  the refusal it always showed, now with the reason.
- The saved tab keeps the address the user typed. A gateway address is this process's and is
  never persisted.
- One listener per app and per cockpit hostname. An app prefers the same port every time, so
  its cookies and storage survive a reopened preview. A listener closes after thirty idle
  minutes, when it is the least recently used and the pool is full, or at shutdown.

## 4. Authentication

The front's login covers the cockpit. It cannot cover the pool: a login prompt inside a frame
is not something a user can answer, and a front that is not cezar's own may not offer one. So
the gateway authenticates every request itself, and the front forwards the pool bare.

1. The cockpit — already behind the front's login — asks the route for a preview and receives
   the gateway origin and a **ticket**: 32 random bytes, single use, valid for a minute.
2. The first page load carries the ticket in the query. The gateway spends it, sets a cookie
   (`HttpOnly`, `SameSite=Lax`, `Secure` over https) and redirects to the same address without it.
3. Every later request, and every WebSocket upgrade, needs the cookie. Without it: `401`, and
   the app is never reached.

Details that are load-bearing:

- **The cookie's name carries the port.** Cookies are scoped by host, not port, so one name
  would let any preview's cookie open every other.
- **The gateway's cookie is stripped** from what the app receives; the app's own cookies pass.
- **Same site, different origin.** The frame and the cockpit share a hostname, so the cookie is
  sent inside the frame; they differ by port, so neither can read the other.
- **A ticket in a URL** reaches the front's access log. It is spent by the request that logs it.

## 5. What it will and will not forward

- Only a loopback `http://` origin, the same rule as Design Mode (`parseDesignTarget`).
- Never cezar itself — the port the request arrived on, or the one cezar advertises to its
  agents — and never another pool port. A preview of the cockpit would be its API behind a
  ticket instead of behind the front's login.
- `Host` is rewritten to the app's. `Origin` and `Referer` are rewritten only when they are the
  gateway's own; a foreign origin reaches the app as sent, so the app's CORS and CSRF rules hold.
- A redirect to the app's own origin is kept inside the gateway.
- Bodies are not touched. The app's absolute addresses are NOT rewritten (§7).

## 6. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Default | Off. | It opens listeners and, with a front, public ports. AGENTS.md: a feature that widens exposure is opt-in behind a `CEZ_*` flag. |
| A capability on `/health`? | No. | The Browser column asks the route and shows its 409. One fewer shape for every client and fixture to carry, and the answer cannot drift from the route's. |
| Who may open a preview | Anyone the front admits to the cockpit. | That user can already start a task, which runs arbitrary commands on the host. A preview of a loopback port grants less. |
| Does the installer wire it? | Not yet. | It is interactive, verified step by step, and cannot be tested here. The wiring is documented; the gateway works behind any front that forwards the pool. |
| Design Mode through the gateway | No. | It needs the picker injected and a `postMessage` channel to a non-loopback cockpit; a separate piece of work. |

## 7. Known limits

- **An app that calls its own backend by absolute address** (`http://localhost:9000` baked into
  a storefront) makes that call from the viewer's browser, to the viewer's machine. The gateway
  cannot rewrite it. The backend can be opened in its own Browser tab to learn its gateway
  address; a project can read `CEZ_TASK_SLOT` to derive stable ones.
- **ngrok and other single-port fronts** cannot forward a pool. The column refuses, with the reason.
- **`https://` loopback apps** are refused, as in Design Mode: the certificate is not one this
  process has a reason to trust.
