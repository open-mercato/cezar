# WebSocket subscription bus (`/api/ws`)

A single per-cockpit WebSocket carrying **topic subscriptions**: the frontend subscribes to the
named event streams it currently needs and unsubscribes the moment it stops needing them, and the
server does the work behind a topic **only while someone is subscribed**. It replaced the
per-tab `GET /api/health` poll (#369) and is the pattern every future live signal should use
instead of a `refetchInterval`.

- Server hub: `src/server/ws.ts` (built and attached in `src/server/server.ts` `startServer`).
- Frontend client: `web/app/src/api/ws.ts`.
- First consumer: the `health` topic → `useHealth` in `web/app/src/api/queries.ts`.

## Why a subscription model (read this before touching either side)

The cockpit shares one laptop's CPU with the agents it runs. Every event the browser receives
costs a frame parse, a listener call, and usually a React re-render. The **entire point** of this
bus is that a tab pays for exactly the streams it is looking at and **nothing else**:

- **The socket is demand-driven end to end.** A topic's server-side publisher — its timer, its
  `git`/CLI shell-outs, its filesystem watcher — starts on the `0 → 1` subscriber transition and
  is **stopped** on `1 → 0`. A workspace with no cockpit open, or a cockpit that navigated away
  from every view using a topic, costs the server **zero** timers and zero shell-outs. This only
  holds if the frontend unsubscribes faithfully; a leaked subscription keeps a server-side
  publisher running forever.
- **Subscribe at the scope that matches the data's actual demand lifetime — no wider, no
  narrower.** This is the whole discipline, and both directions are mistakes:
  - A **per-view** signal (one run's live diff, a route-specific stream) belongs in that view's
    hook, so it releases when the user leaves. Subscribing to it from the session-long shell keeps
    it live for screens that never look at it — bloat.
  - A **session-global** signal — one the always-present shell renders for the whole session —
    belongs in **one** subscription at the app root, subscribed once for the session. Subscribing
    to it from each of the many components that read it (health has ~15 readers) ties a global
    signal to component lifecycles: it flaps `subscribe`/`unsubscribe` on every mount, unmount and
    StrictMode remount, and drops entirely for any instant no reader happens to be mounted. That
    is exactly the "we unsubscribed from health" churn to avoid.
  - **Health is the worked example.** It feeds the shell's repo/branch chip, version chip, nav
    gating and Tools menu, so its demand *is* the whole session. One `useHealthSubscription()` at
    the root (`GlobalEventsProvider`) holds it live continuously in local mode; `useHealth()` is a
    pure cache **read** that any component may call without touching the socket. In remote mode the
    authenticated HTTP bootstrap reports `localHandoff: false`, and the hook deliberately opens no
    WebSocket: browser WebSocket has no credentials option, so a Basic Auth proxy can otherwise
    challenge every reconnect forever. Remote health uses HTTP bootstrap plus the workspace SSE's
    reconnect/visibility reconciliation. Separate the subscription (once, at the demand scope)
    from the read (anywhere), and fail closed to HTTP until deployment mode is known.
- **Always return the unsubscribe.** In React that means `useEffect(() => subscribeTopic(...),
  [])` — the effect returns the unsubscribe so unmount releases it. An unsubscribe that never
  runs is a memory leak on the client (a listener retained) **and** a resource leak on the server
  (a publisher never stopped) **and** a bloat leak (that component keeps waking on every event
  for a screen the user left). For a session-global topic the single root subscription is released
  only when the app tears down — which is correct: its demand ends with the session.
- **One socket, many topics.** There is exactly one WebSocket per cockpit (same per-origin
  connection-budget reason as the SSE stream). Never open your own `new WebSocket` for a feature;
  add a topic and subscribe to it. N components subscribing to the same topic share **one**
  server-side publisher and **one** subscribe frame — the client ref-counts listeners per topic.
- **Publish only on change.** A publisher must broadcast only when its payload actually changed
  (the `health` topic diffs the serialized snapshot before pushing). Re-broadcasting an unchanged
  value is exactly the bloat this design exists to prevent — it wakes every subscriber's reducer
  for nothing.

If you find yourself wanting "just subscribe to everything at the top and filter in the
component", stop: that is the bloat failure mode. Filter by **subscribing to the right topic**,
not by receiving everything and ignoring most of it.

### Why a WebSocket and not another SSE stream

The repo already has SSE (`/api/workspace/events`), and reaching for a new server runtime
dependency needs an answer (`CODE_REVIEW.md` priority 5). The answer is direction: the entire
design is the **client telling the server what it currently needs**, and SSE is one-way. Over SSE
each subscribe/unsubscribe would be a separate `POST` correlated to the stream by a connection id
the server would have to mint, track and expire — a second protocol bolted onto the first, whose
failure mode (a POST that lands after its stream died) is exactly the leaked publisher this design
exists to prevent. A WebSocket makes subscribe/unsubscribe and the connection's own lifetime the
same thing, so a dropped socket *is* an unsubscribe. `ws` is the cost of that, and it is why
`CODE_REVIEW.md`'s dependency budget grew by one.

The SSE stream stays where it is: it carries run/event traffic the client never opts out of.
Use it for firehose-shaped signals; use a topic for anything whose demand comes and goes.

## Wire protocol

One JSON frame per message, both directions.

Client → server:

```jsonc
{ "type": "subscribe",   "topic": "health" }
{ "type": "unsubscribe", "topic": "health" }
```

Server → client:

```jsonc
{ "type": "event", "topic": "health", "data": { /* topic payload */ } }
{ "type": "error", "topic": "health", "error": "unknown topic" }    // no such topic registered
{ "type": "error", "topic": "run-x",  "error": "forbidden topic" }  // untrusted conn, non-public topic (see Security)
{ "type": "error", "error": "malformed frame: …" }                  // topic omitted for malformed frames
{ "type": "ping" }                                                  // liveness beat (see Liveness)
```

A `subscribe` is answered immediately with a fresh **snapshot** `event`, so a subscriber never
waits out a publisher interval to render, and a reconnect catches up on whatever changed while the
socket was gone. Frames are validated with zod and capped at 4 KB; a malformed frame gets an
`error` back and the connection stays up (one buggy caller must not drop its tab's other topics).

## Adding a server-side topic

Register it on the hub in `createApp` (guarded by `deps.socketHub?`, which only the live server
injects). A topic is a `TopicPublisher`:

```ts
deps.socketHub?.registerTopic('my-topic', {
  // Fresh payload for a just-arrived subscriber (and every reconnect). Cheap or cached.
  snapshot: async () => currentValue(),
  // Called on 0 → 1. Start producing; `publish` broadcasts to every subscriber. Return the stop
  // function, called on 1 → 0 — tear down the timer/watcher/listener here, completely.
  start: (publish) => {
    const off = watchSomething((next) => publish(next)) // publish ONLY on real change
    return () => off()
  },
})
```

Rules: publish **only on change**; make `start`/stop symmetric (whatever `start` opens, the
returned function must close); keep `snapshot` cheap (cache if it is not — see the `health` cache
in `server.ts`). Topic names carry workspace-level data, so the hub is single-mount on `/api/ws`
and never mirrored under `/api/p/:projectId`. `attach` is boot-time wiring like `registerTopic`:
calling it twice throws rather than silently orphaning the first heartbeat interval.

A third argument controls who may read the topic — and its default is the safe one:

```ts
// Default (omit the options): TRUSTED connections only — the cockpit itself, a
// no-Origin native client, or a dev proxy the browser vouched for. This is what
// any topic carrying run/repo/PR content wants.
deps.socketHub?.registerTopic('run-changes:<id>', publisher)

// Opt in ONLY for data already safe for any local page (see the security section):
deps.socketHub?.registerTopic('health', publisher, { loopbackReadable: true })
```

**If a topic's snapshot shares a cache with an HTTP route, bound the staleness.** The `health`
cache is stale-while-revalidate with *two* numbers, and the second one is the load-bearing one:
`HEALTH_TTL_MS` decides how often a revalidation is kicked off, but the revalidation is
fire-and-forget, so on its own it bounds nothing. While a cockpit holds the topic the publisher's
interval keeps the cache warm — but the normal state of a background `cezar serve` is **no
subscriber**, and then nothing refreshes it at all, so a GET an hour later would answer with the
boot pre-warm's payload. `HEALTH_MAX_STALE_MS` is the ceiling past which the read waits for a real
compute instead of serving the cache. Any future topic that fronts a route needs the same pair.

**Security — the topic-safety invariant is mechanical, not a rule to remember.** The upgrade
guard (`verifyWsUpgrade`, `server.ts`) admits the cockpit itself (same authority), and — because
WebSocket is not subject to CORS and the Vite dev proxy runs on another localhost port — a
**loopback** origin against a loopback Host. `Sec-Fetch-Site` is honored when the browser sends it
(Chromium does on a WS handshake, and page JS cannot forge it), so an explicit `cross-site` /
`same-site` handshake is refused even between two loopback ports; it cannot be *required*, because
Safari sends no `Sec-Fetch-*` at all and that would lock the dev proxy out. So on a browser that
omits the header, a page on another local port is still admitted.

That residual admission is why the guard doesn't return a bare boolean — it returns a **trust**
verdict, and the hub enforces it per subscription:

- **Trusted** = provably the cockpit: a same-authority Origin, a no-Origin native client, or a dev
  proxy the browser vouches for via `Sec-Fetch-Site: same-origin`. May read any topic.
- **Untrusted** = admitted by the loopback fallback on a no-`Sec-Fetch` browser (indistinguishable
  from a foreign local page). May read **only** topics registered `{ loopbackReadable: true }`; any
  other `subscribe` gets an `{ type: 'error', topic, error: 'forbidden topic' }` and never starts a
  publisher.

Because `loopbackReadable` **defaults to `false`**, a new topic carrying run/repo/PR content is
safe the moment it is registered — a foreign local page cannot read it and no one had to remember
to tighten anything. `health` is the one topic that opts in (`{ loopbackReadable: true }`), because
it is the same payload the CORS-open `GET /api/health` already exposes (#431). This is the
mechanical form of what used to be a written caveat: adding a sensitive topic requires *doing
nothing* special; exposing one to any local page requires an *explicit* opt-in.

## Consuming a topic on the frontend

Use the shared socket via `subscribeTopic`, always inside an effect that returns the unsubscribe,
and place that effect at the topic's demand scope (see the discipline above):

```ts
useEffect(
  () => subscribeTopic('my-topic', (data) => {
    // fold into the query cache; do NOT trigger a refetch per event
    queryClient.setQueryData(myKey, data as MyShape)
  }),
  [queryClient],
)
```

Health is the reference consumer, and it shows the split every session-global topic should use:

- `useHealthSubscription()` — the ONE subscription controller, called once from
  `GlobalEventsProvider` (the root that is mounted for the app's whole life, alongside the SSE
  stream). After authenticated health bootstrap it subscribes only when `localHandoff` is true and
  folds pushed payloads into the TanStack Query cache in place. Remote mode opens no WebSocket.
- `useHealth()` — a pure `useQuery` **read** with no side effect, called by the ~15 components
  that show health. They share one cache and none of them touches the socket, so mounting and
  unmounting them never subscribes or unsubscribes anything.

A plain `GET /api/health` remains the authoritative bootstrap and the reconcile target (the same
split the SSE stream uses — `web/app/src/api/global-events.tsx`). Do not add a `refetchInterval`;
the topic is the live channel. The cache key is read inside the fold callback (`queryKeys.health`
is a scope-aware getter), so a project switch routes each pushed snapshot to the active scope's
cache without re-subscribing.

## Liveness — reap the dead, reconnect the living

A dropped connection must not leave a publisher running server-side or a stale screen client-side.

- **Server reaps dead clients.** A heartbeat interval (`HEARTBEAT_MS`, 30 s) protocol-pings every
  client; one that missed the previous beat's pong is terminated, which releases its topic
  subscriptions so publishers can stop. A killed browser process sends no FIN, so this ping/pong
  is the only thing that frees its resources.
- **Server emits a visible beat.** The browser never surfaces a protocol ping to page JS, so on
  the same interval the server also sends an app-level `{ "type": "ping" }` frame — the signal the
  client's watchdog watches.
- **Client reconnects on a normal drop.** A `close` event (server restart, clean drop) schedules a
  reconnect after a 3 s backoff and re-subscribes every held topic; each re-subscribe returns a
  fresh snapshot, so the caches catch up with no extra reconcile step.
- **Client reconnects on a silent drop.** A sleep or network partition delivers no FIN, so no
  `close` fires and the socket would sit `OPEN` forever hearing nothing. A watchdog
  (`HEARTBEAT_TIMEOUT_MS`, 70 s — two missed 30 s beats) resets on **any** inbound frame,
  including the heartbeat ping; if it ever fires, the socket is silently dead, so the client closes
  it and takes the normal reconnect path.
- **Idle close.** When the last listener on the whole socket unsubscribes, the client closes the
  socket after a 1 s grace (the grace absorbs StrictMode remounts and route hops). No subscriber,
  no socket.

## Testing

- `src/server/ws.test.ts` drives the hub over real sockets: publisher start/stop on the
  subscriber count, broadcast fan-out, unknown/malformed frames, the 403 pre-handshake rejection,
  the app-level heartbeat, reaping a client that stops answering the protocol ping
  (`autoPong: false`), and the double-`attach` throw. `verifyWsUpgrade` has its own unit table —
  which controls `CEZ_REMOTE`, because the guard's whole Host half is skipped in hosted mode and
  an ambient var on the dev box must not decide what the table sees.
- `src/server/health-topic.test.ts` covers the **live-server** path — the one `createApp` only
  builds when a `socketHub` is injected, which every other server suite leaves untaken: the boot
  pre-warm, the SWR window, the staleness ceiling, publish-only-on-change, stop-releases-the-timer,
  the in-flight dedupe, and that a hub-less app still computes fresh per request. Inject a stub
  hub that just records what `registerTopic` is handed; that is enough to drive the topic by hand.
- `web/app/src/api/ws.test.ts` drives the client against a fake WebSocket with fake timers:
  lazy connect, per-topic ref-counting (one subscribe frame per topic), unsubscribe → idle close,
  reconnect on drop and on watchdog timeout, and the heartbeat resetting the watchdog.
- `web/app/src/api/queries.test.tsx` covers `useHealth` folding pushed frames instead of polling.
