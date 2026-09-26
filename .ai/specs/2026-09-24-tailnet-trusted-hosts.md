# Tailnet access without hosted mode — an opt-in trusted-host allowlist

> Slug: `tailnet-trusted-hosts` · Status: proposed · Gated by a new opt-in variable
> (`CEZ_TRUSTED_HOSTS`, default empty = today's behaviour).
> Extends: the server-installer remote-access work, and the request-origin guard (#426).

## TLDR

There are two supported ways to reach a cockpit from another machine today: **hosted mode**
(`CEZ_REMOTE=1` behind a public front with a login — loses local handoff, home files and
agent-config editing), or a **tunnel that terminates on the client** (`ssh -L`, so the cockpit
still sees loopback). A third case is common and unsupported: a **private network that already
authenticates devices** (a tailnet) fronting a *local-mode* cockpit. Every such request is refused
by the loopback Host allowlist (#426) even though the network already authenticates the caller.

This spec adds one explicit, default-off knob: `CEZ_TRUSTED_HOSTS=host[:port],…`. Requests whose
`Host` authority is in that list are treated like loopback by the `/api/*` origin guard and by
`verifyWsUpgrade`; everything else is unchanged, hosted mode is untouched, and the cockpit stays in
**local mode** (full features). No new transport, no client app, no bundled proxy.

## Why this shape

- **The guard exists to stop DNS rebinding, not to forbid reverse proxies.** A rebound `evil.com`
  still sends `Host: evil.com` — not in the list, still refused. The CSRF write guard is unchanged:
  `Origin` must still match the served `Host`.
- **Explicit over blanket.** The operator names the authority. Deliberately no wildcard and no
  "trust any non-loopback host" switch.
- **Precedent, not invention.** Django's `ALLOWED_HOSTS`, Rails' `config.hosts`, Vite's
  `server.allowedHosts` — the same pattern, the same reasoning.
- **It keeps the feature set.** The alternative (`CEZ_REMOTE=1`) is a product decision to trade
  local-mode affordances for reach. Right for a VPS, wrong for a private front.
- **It is the smallest thing that makes the private-front case work** — and the QR handoff
  (below) becomes a two-line addition instead of a reason to build a client.
- **The perimeter moves to the network, and this document says so.** A trusted authority keeps
  `capabilities.localHandoff` true, so the local-only surfaces stay reachable — that is the point,
  and it is also the risk. The assumptions below name exactly what the operator is trusting.

## Resolved assumptions

| # | Question | Applied default | Why |
|---|---|---|---|
| A1 | Shape of the value | Comma-separated authorities, port-aware (`host:port`), compared as an authority like the existing `authorityOfHost` | The guard already compares authorities; a port-less entry matches only a port-less Host. |
| A2 | Wildcards | None | A wildcard re-opens rebinding; list several hosts instead. |
| A3 | Does it weaken #426? | No — rebinding still fails; cross-origin writes still fail (Origin ≠ Host) | An allowlist extension, not a bypass. |
| A4 | Hosted mode | Untouched; the variable is ignored when `CEZ_REMOTE=1`/non-loopback bind already admits any Host | One predicate, not two. |
| A5 | WebSocket | `verifyWsUpgrade` consults the same list; trusted Host with a matching Origin authority is `trusted: true` | Live channels must work, not just HTTP. |
| A6 | Observability | One boot log line naming the trusted hosts; `/api/v1/health` unchanged | Operators need to see it took effect. |
| A7 | How the QR learns the phone's URL | `CEZ_PUBLIC_URL` names it explicitly; without it, a non-loopback `--bind-host` is used; a loopback cockpit prints nothing, and `CEZ_NO_QR=1` (or any CI) silences it | A proxy URL is not derivable from the bind address, and printing a QR for `localhost` is noise. |
| A8 | QR encoder | `qrcode-generator` (MIT, zero runtime dependencies) for the module matrix, rendered as half-block text by our own ~30-line formatter | No vendored encoder to maintain and no dependency tree; the terminal formatter stays ours and unit-testable. |
| A9 | What a trusted authority reaches | It is admitted by the two Host admission checks **only**. `capabilities.localHandoff` stays true, so anything able to reach that authority and present it also reaches the local-only surfaces: agent-config editing (`PUT /api/agent-config/:id` — the gate that closes a hooks-based RCE path), home-wide `GET /api/v1/fs/browse`, `GET /api/v1/launch-key`, and Origin-less writes/WS. The operator must restrict the authority to a private, device-authenticating network (tailnet ACL or equivalent `serve` restriction), never a Funnel/public front; the banner prints a boot warning naming those surfaces. | The one-line "keep the ACL tight" note in the docs page was not enough — the boundary belongs in the contract, where review can see it. |
| A10 | Matching unit and parser contract | The request's **raw `Host` authority**, lowercased, compared exactly. An empty or unparseable entry never matches. `*` is not a wildcard — a literal that matches no authority. A scheme or path is tolerated only as input convenience (the pasted-URL case). IPv6 must be bracketed (`[fd7a::1]:8445`). An explicit default port (`host:443`) is a different authority from `host`. Trailing dots are not normalized. `X-Forwarded-Host` is never consulted. Matching is case-insensitive. | A1 named the unit but not its contract; each of these is a way to believe a host is trusted when it is not. |
| A11 | QR URL rule | `CEZ_PUBLIC_URL` is an absolute URL and **only the URL is ever printed** — never the launch key or a query token. In local mode the printed authority must be in `CEZ_TRUSTED_HOSTS`; when it is not, the banner warns instead of handing the user a link that lands on the 403 this feature removes. | The QR exists to remove a manual step; a QR that leads to a refusal is worse than no QR. |
| A12 | When the variables are read | Per request, memoized by raw value, exactly like `CEZ_REMOTE` — flipping `CEZ_TRUSTED_HOSTS` takes effect without a restart | Matches the existing capability semantics and keeps tests able to toggle it. |

## Proposed solution

1. Parse `CEZ_TRUSTED_HOSTS` into a set of authorities (read per request, memoized by raw value);
   add `isTrustedHostHeader(host, trusted)`, which matches the request's **raw `Host` authority** —
   not the port-stripped canonical name `isLoopbackHostHeader` receives.
2. `/api/*` guard: accept loopback **or** trusted; keep the `Origin`-vs-`Host` comparison and the
   `Sec-Fetch-Site` belt-and-suspenders unchanged.
3. `verifyWsUpgrade`: same addition; the existing `trusted` verdict logic is unchanged.
4. CLI: print the address as a **QR code** in the terminal banner — `CEZ_PUBLIC_URL` when set,
   otherwise a non-loopback `--bind-host` — so the phone can scan it. Never printed for a loopback
   address, silenced by `CEZ_NO_QR=1` or a CI environment. Authority-only URL (A11); a boot warning
   when the target is not in `CEZ_TRUSTED_HOSTS`; the same commit carries the `.env.example` and
   `docs/reference.md` rows the repo requires for new variables, and states the three things the
   loopback guard keeps (bind unchanged, CORS unchanged, loopback-only fallbacks stay
   loopback-only).
5. Docs: a `docs/server-install/tailnet.md` page — the recipe (tailnet front, `tailscale serve` or
   a direct tailnet bind), the value for `CEZ_TRUSTED_HOSTS`, the QR handoff, and a security note
   that the private network now owns what the loopback guard used to.

## Not in scope

No `cez phone` command, no bundled proxy, no public exposure (Funnel/ngrok-style), no authentication
layer of our own. Those are separate decisions.

## Validation gate

`npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`, plus:

- unit tests for the parser (empty, single, multi, port, IPv6, duplicates, whitespace) plus the
  negatives that must never match: an empty entry, `*`, a bare `host` against `host:8445`, a
  trailing dot — and the case variant that must still match;
- guard tests: trusted Host accepted; unlisted Host refused; an **unlisted private address** still
  refused (the #426 case must not regress); trusted Host with a foreign Origin refused for writes;
  a trusted Host with a **matching** Origin accepted for a write through a real route;
- `verifyWsUpgrade` tests for the trusted-Host case, trusted vs untrusted verdict;
- a hosted-mode regression: with `CEZ_REMOTE=1` the allowlist is irrelevant and behaviour is
  unchanged;
- a CLI test for the QR banner: printed for a non-loopback URL, absent for loopback, suppressed by
  the opt-out, plus the coherence warning when the target is not trusted;
- a docs link from `docs/server-install/README.md`.

## Evidence from the field (2026-09-24)

Measured on a real tailnet front (Tailscale address, cockpit bound to loopback, local mode):

| Probe | Without the knob | With an equivalent allowlist |
|---|---|---|
| `GET /` | 200 (static shell) | 200 |
| `GET /api/v1/health` | 403 `unexpected Host header` (#426) | 200, `capabilities.localHandoff: true`, 8 projects |
| `WebSocket /api/v1/ws` | 403 at the guard | 101, first frame `{"type":"ping"}` |
| `GET /api/v1/workspace/events` (SSE) | 403 | 200 `text/event-stream`, live `event: usage` |

The middle column is why this spec exists; the right column is what it makes first-class instead of
requiring a header-rewriting bridge in front of the cockpit.
