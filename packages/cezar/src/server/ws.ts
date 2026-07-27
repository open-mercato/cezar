import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';

/**
 * The cockpit's WebSocket subscription bus (`GET /api/ws`, upgrade-only).
 * Design + the subscribe/unsubscribe discipline: spec
 * `.ai/specs/2026-07-23-websocket-subscriptions.md`.
 *
 * One socket per cockpit, many topics per socket: the client sends
 * `{type:'subscribe'|'unsubscribe', topic}` frames and receives
 * `{type:'event', topic, data}` frames for the topics it holds. The point of
 * the topic layer is that server-side work is DEMAND-DRIVEN: a topic's
 * publisher starts when its subscriber count goes 0→1 and is stopped at 1→0,
 * so a workspace with no cockpit open (or a cockpit that navigated away from
 * everything using a topic) costs zero timers, zero shell-outs, zero anything.
 * That is what replaced the per-tab `GET /api/health` poll (#369): N tabs used
 * to mean N polls every 5 s forever; now they mean one publisher while at
 * least one tab subscribes, and none afterwards.
 *
 * Security: the hub itself never decides who may connect — `attach` takes the
 * upgrade guard as a function, and server.ts supplies the WebSocket twin of
 * the `/api/*` request-origin guard (#426). See `verifyWsUpgrade` there for
 * what it admits, and the caveat about which topics may live on this hub.
 */

/** The one upgrade path. Workspace-level like `/api/workspace/events` — never
 *  mirrored under `/api/p/:projectId` (topics carry workspace data). */
export const WS_PATH = '/api/ws';

/** Heartbeat cadence — the interval on which the hub both REAPS silently-dead
 *  clients (a killed browser process sends no FIN) and emits a liveness beat
 *  every client can see. A client that missed the previous beat's pong is gone;
 *  terminating it releases its topic subscriptions so publishers can stop. */
const HEARTBEAT_MS = 30_000;

/** Client frames are tiny control messages; anything bigger is not our
 *  protocol. Kills the abuse case of a page streaming megabytes at the hub. */
const MAX_PAYLOAD_BYTES = 4_096;

/** Everything a client may say. Malformed frames get an `error` frame back
 *  (not a disconnect — one buggy caller must not tear down its tab's other
 *  subscriptions). */
const clientFrameSchema = z.object({
  type: z.enum(['subscribe', 'unsubscribe']),
  topic: z.string().min(1).max(128),
});

export interface TopicPublisher {
  /** Fresh payload for a subscriber that just arrived — sent immediately so a
   *  (re)connecting cockpit never waits out a publisher interval to render. */
  snapshot(): Promise<unknown>;
  /** Subscriber count went 0→1: start producing. Call `publish` whenever the
   *  topic has news (every call is broadcast verbatim to all subscribers).
   *  Returns the stop function, called at 1→0. */
  start(publish: (data: unknown) => void): () => void;
}

export interface TopicOptions {
  /** Whether an ADMITTED-BUT-UNTRUSTED connection may subscribe (see
   *  `WsUpgradeVerdict`). Defaults to `false` — the safe default that makes the
   *  topic-safety invariant mechanical: a topic carrying run/repo/PR content is
   *  legible only to the cockpit itself unless a publisher explicitly opts in.
   *  Set `true` only for data already safe for any local page (e.g. `health`,
   *  the CORS-open discovery payload). */
  loopbackReadable?: boolean;
}

/**
 * The upgrade guard's verdict: reject, or admit at a trust level.
 *
 * `false` — reject the handshake (403). A `trusted` connection is provably the
 * cockpit itself — a same-authority Origin, a no-Origin native client, or a dev
 * proxy the browser vouches for via `Sec-Fetch-Site` — and may subscribe to any
 * topic. A NON-`trusted` connection was admitted by the loopback-origin fallback
 * on a browser that ships no `Sec-Fetch` metadata, where the dev proxy and a
 * foreign page on another local port are indistinguishable at the handshake: it
 * may subscribe ONLY to topics a publisher flagged `loopbackReadable`.
 */
export type WsUpgradeVerdict = false | { trusted: boolean };

/** The minimal server surface `attach` needs — satisfied by the `http.Server`
 *  that `@hono/node-server`'s `serve()` returns. */
export interface UpgradeCapableServer {
  on(event: 'upgrade', listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}

export interface SocketHub {
  /** Register a topic clients may subscribe to. Registration is boot-time
   *  wiring (createApp), so a duplicate name is a programming error: throw.
   *  `options.loopbackReadable` defaults to `false` (topic legible to trusted
   *  connections only) — see `TopicOptions`. */
  registerTopic(name: string, publisher: TopicPublisher, options?: TopicOptions): void;
  /** Start accepting `WS_PATH` upgrades on `server`. `verifyUpgrade` is the
   *  request-origin guard — `false` answers 403 before the handshake, otherwise
   *  its `trusted` flag decides which topics the connection may read. Boot-time
   *  wiring like `registerTopic`: attaching twice throws. */
  attach(server: UpgradeCapableServer, verifyUpgrade: (req: IncomingMessage) => WsUpgradeVerdict): void;
  /** Stop publishers, terminate clients, clear timers. Idempotent; also runs
   *  on the attached server's own `close`. */
  close(): void;
}

interface TopicState {
  publisher: TopicPublisher;
  subscribers: Set<WebSocket>;
  /** Non-null exactly while the publisher runs (≥1 subscriber). */
  stop: (() => void) | null;
  /** `TopicOptions.loopbackReadable`, resolved (default `false`). */
  loopbackReadable: boolean;
}

interface ClientState {
  /** Flipped by `pong`, cleared before each `ping` — two silent beats = dead. */
  alive: boolean;
  topics: Set<string>;
  /** The upgrade verdict's trust flag (see `WsUpgradeVerdict`). An untrusted
   *  connection may subscribe only to `loopbackReadable` topics. */
  trusted: boolean;
}

export interface SocketHubOptions {
  /** Heartbeat interval override (ms). Defaults to `HEARTBEAT_MS`; tests set it
   *  small so reaping and the liveness beat are observable without a 30 s wait. */
  heartbeatMs?: number;
}

export function createSocketHub(options: SocketHubOptions = {}): SocketHub {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const topics = new Map<string, TopicState>();
  const clients = new Map<WebSocket, ClientState>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const send = (ws: WebSocket, frame: unknown): void => {
    // OPEN as the literal 1: the check must hold for any socket implementation.
    if (ws.readyState === 1) ws.send(JSON.stringify(frame));
  };

  const subscribe = (ws: WebSocket, client: ClientState, topic: string): void => {
    const state = topics.get(topic);
    if (!state) {
      send(ws, { type: 'error', topic, error: 'unknown topic' });
      return;
    }
    if (!state.loopbackReadable && !client.trusted) {
      // Admitted by the loopback-origin fallback (a browser with no Sec-Fetch,
      // so indistinguishable from a foreign local page): only topics explicitly
      // marked safe for any local page are legible. This is the mechanical half
      // of the topic-safety invariant — the guard opens the door, the flag says
      // which rooms an unproven caller may enter.
      send(ws, { type: 'error', topic, error: 'forbidden topic' });
      return;
    }
    if (client.topics.has(topic)) return; // idempotent — a re-sent frame must not double anything
    client.topics.add(topic);
    state.subscribers.add(ws);
    if (state.stop === null) {
      state.stop = state.publisher.start((data) => {
        for (const subscriber of state.subscribers) send(subscriber, { type: 'event', topic, data });
      });
    }
    // The immediate snapshot — async, so the socket or the subscription may be
    // gone by the time it resolves; both are re-checked. A failing snapshot is
    // dropped: the publisher's next publish carries the same news.
    void state.publisher
      .snapshot()
      .then((data) => {
        if (client.topics.has(topic)) send(ws, { type: 'event', topic, data });
      })
      .catch(() => undefined);
  };

  const unsubscribe = (ws: WebSocket, client: ClientState, topic: string): void => {
    if (!client.topics.delete(topic)) return;
    const state = topics.get(topic);
    if (!state) return;
    state.subscribers.delete(ws);
    if (state.subscribers.size === 0 && state.stop !== null) {
      state.stop();
      state.stop = null;
    }
  };

  const dropClient = (ws: WebSocket): void => {
    const client = clients.get(ws);
    if (!client) return;
    for (const topic of [...client.topics]) unsubscribe(ws, client, topic);
    clients.delete(ws);
  };

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, trusted?: boolean) => {
    // `trusted` is emitted by `attach` from the upgrade verdict; default false is
    // the safe read for any path that reaches here without one.
    const client: ClientState = { alive: true, topics: new Set(), trusted: trusted === true };
    clients.set(ws, client);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        send(ws, { type: 'error', error: 'malformed frame: not JSON' });
        return;
      }
      const frame = clientFrameSchema.safeParse(parsed);
      if (!frame.success) {
        send(ws, { type: 'error', error: 'malformed frame: expected {type: subscribe|unsubscribe, topic}' });
        return;
      }
      if (frame.data.type === 'subscribe') subscribe(ws, client, frame.data.topic);
      else unsubscribe(ws, client, frame.data.topic);
    });
    ws.on('close', () => dropClient(ws));
    // A socket error is followed by `close`; the handler exists so ws never
    // throws it as an unhandled 'error' event.
    ws.on('error', () => undefined);
  });

  const hub: SocketHub = {
    registerTopic(name, publisher, options) {
      if (topics.has(name)) throw new Error(`ws topic already registered: ${name}`);
      topics.set(name, {
        publisher,
        subscribers: new Set(),
        stop: null,
        loopbackReadable: options?.loopbackReadable ?? false,
      });
    },

    attach(server, verifyUpgrade) {
      // Boot-time wiring like `registerTopic`, so a second call is a programming
      // error rather than something to absorb: it would install a second
      // `upgrade` listener and orphan the first heartbeat interval (`close`
      // clears only the last one). Throw the same way registration does.
      if (heartbeat !== undefined) throw new Error('ws hub already attached');
      server.on('upgrade', (req, socket, head) => {
        // `req.url` on an upgrade is the request path (+query); the base is
        // only there to satisfy URL parsing of a relative reference.
        const pathname = new URL(req.url ?? '', 'http://localhost').pathname;
        if (pathname !== WS_PATH) {
          // With an `upgrade` listener installed, Node no longer auto-destroys
          // unhandled upgrades — do it explicitly or the socket leaks.
          socket.destroy();
          return;
        }
        const verdict = verifyUpgrade(req);
        if (!verdict) {
          socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        // Carry the verdict's trust flag onto the connection — `subscribe` reads
        // it to gate non-`loopbackReadable` topics.
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, verdict.trusted));
      });
      server.on('close', () => hub.close());
      heartbeat = setInterval(() => {
        for (const [ws, client] of clients) {
          if (!client.alive) {
            // Missed the previous beat's pong — the peer is gone. Terminate (not
            // a polite close, there is nobody to handshake with); 'close' fires
            // synchronously and dropClient releases its topics.
            ws.terminate();
            continue;
          }
          client.alive = false;
          ws.ping(); // protocol ping — a live browser auto-pongs, flipping `alive` back
          // App-level beat too. The browser NEVER surfaces the protocol ping to
          // page JS, so a client cannot tell a silent-dead socket (sleep, network
          // partition — no FIN ever arrives) from an idle-but-healthy one on the
          // protocol ping alone. This visible frame is what the client's own
          // watchdog watches to decide to reconnect. Sent to every client,
          // subscribed or not; the client ignores it beyond noting liveness.
          send(ws, { type: 'ping' });
        }
      }, heartbeatMs);
      // Never the reason the process stays up — the HTTP server owns lifetime.
      heartbeat.unref?.();
    },

    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const ws of [...clients.keys()]) {
        dropClient(ws); // stops publishers even if 'close' events never get to fire
        ws.terminate();
      }
      wss.close();
    },
  };

  return hub;
}
