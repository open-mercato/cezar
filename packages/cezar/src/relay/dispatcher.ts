import { HOP_BY_HOP_HEADERS, MAX_HEAD_CONTENT, RESET, encodeFrame, isDroppedRequestHeader, type TunnelFrame, type TunnelHeaders } from './wire.ts';

export const STREAM_WINDOW = 262_144;
const CREDIT_THRESHOLD = 65_536;
/** Read no further ahead of the tunnel than this, so a stalled phone stalls the producer. */
const OUTGOING_LIMIT = 131_072;
/** Never a real host, so nothing can mistake it for this machine. */
const RELAY_ORIGIN = 'http://relay.invalid';
const BODYLESS = new Set(['GET', 'HEAD']);

export interface StreamHost {
  sendFrame(frame: TunnelFrame): void;
  dataSlot(): Promise<void>;
  streamDone(id: number): void;
  readonly maxData: number;
}

type OpenFrame = Extract<TunnelFrame, { type: 'open' }>;
type StreamFrame = Extract<TunnelFrame, { type: 'data' | 'end' | 'reset' | 'window' }>;

/** Builds the request `app.fetch` sees. Identity comes from the session, never from a header. */
export function requestFromOpen(open: OpenFrame, body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Request | null {
  const headers = new Headers();
  try {
    for (const [name, value] of open.headers) {
      if (name === 'upgrade') return null; // No WebSocket crosses the tunnel, § 13.1.
      if (!isDroppedRequestHeader(name)) headers.append(name, value);
    }
    headers.set('host', 'relay.invalid');
    return new Request(`${RELAY_ORIGIN}${open.target}`, {
      method: open.method,
      headers,
      signal,
      ...(body ? { body, duplex: 'half' } : {}),
    } as RequestInit);
  } catch {
    return null;
  }
}

/** One HTTP exchange. Only `PhoneSession.open` builds one, so only the phone starts a stream. */
export class TunnelStream {
  private readonly id: number;
  private readonly aborter = new AbortController();
  private sendWindow = STREAM_WINDOW;
  private recvWindow = STREAM_WINDOW;
  private windowWaiter: (() => void) | undefined;
  private credit = 0;
  private finished = false;
  private requestEnded = false;
  private responseEnded = false;
  private received = 0;
  private readonly expectedLength: number | undefined;
  private chunks: Buffer[] = [];
  private bodyWake: (() => void) | undefined;
  private bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private outgoing: Buffer[] = [];
  private outgoingBytes = 0;
  private readerDone = false;
  private flushWaiter: (() => void) | undefined;
  private drained: (() => void) | undefined;

  constructor(
    private readonly open: OpenFrame,
    private readonly host: StreamHost,
    private readonly fetch: (request: Request) => Promise<Response>,
  ) {
    this.id = open.stream;
    const length = open.headers.find(([name]) => name === 'content-length')?.[1];
    this.expectedLength = length !== undefined && /^\d+$/.test(length) ? Number(length) : undefined;
    // A GET can finish before its END frame arrives, and that is not an unfinished body.
    this.requestEnded = BODYLESS.has(open.method);
  }

  start(): void {
    const bodyless = BODYLESS.has(this.open.method);
    const request = requestFromOpen(this.open, bodyless ? null : this.bodyStream(), this.aborter.signal);
    if (!request) {
      this.reset(RESET.badRequest);
      return;
    }
    void this.run(request);
  }

  private bodyStream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => { this.bodyController = controller; },
      pull: (controller) => this.pullBody(controller),
      cancel: () => { this.requestEnded = true; },
    }, { highWaterMark: 0 });
  }

  private async pullBody(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    for (;;) {
      const next = this.chunks.shift();
      if (next) {
        controller.enqueue(next);
        this.grant(next.length);
        return;
      }
      if (this.requestEnded) {
        try { controller.close(); } catch { /* already errored by a reset */ }
        return;
      }
      await new Promise<void>((resolve) => { this.bodyWake = resolve; });
    }
  }

  /** Credit as the consumer takes bytes, by 131,072 at the latest, § 12.2. */
  private grant(bytes: number): void {
    this.credit += bytes;
    this.recvWindow += bytes;
    if (this.credit < CREDIT_THRESHOLD && this.chunks.length > 0) return;
    if (!this.finished) this.host.sendFrame({ type: 'window', stream: this.id, increment: this.credit });
    this.credit = 0;
  }

  private async run(request: Request): Promise<void> {
    try {
      const response = await this.fetch(request);
      await this.respond(response);
    } catch {
      this.reset(RESET.internal);
    }
  }

  private responseHeaders(response: Response): TunnelHeaders | null {
    const headers: TunnelHeaders = [];
    response.headers.forEach((value, name) => {
      if (!HOP_BY_HOP_HEADERS.has(name)) headers.push([name, value]);
    });
    const content = encodeFrame({ type: 'head', stream: this.id, status: response.status, headers });
    return content.length > MAX_HEAD_CONTENT ? null : headers;
  }

  private async respond(response: Response): Promise<void> {
    if (this.finished) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    const headers = this.responseHeaders(response);
    if (!headers) {
      await response.body?.cancel().catch(() => {});
      this.reset(RESET.headTooLarge);
      return;
    }
    if (response.status < 200 || response.status > 599) {
      this.reset(RESET.internal);
      return;
    }
    this.host.sendFrame({ type: 'head', stream: this.id, status: response.status, headers });
    if (response.body && this.open.method !== 'HEAD') {
      const flushed = this.flush();
      this.reader = response.body.getReader();
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done || this.finished) break;
        this.outgoing.push(Buffer.from(value));
        this.outgoingBytes += value.length;
        this.wakeFlush();
        if (this.outgoingBytes >= OUTGOING_LIMIT) await new Promise<void>((resolve) => { this.drained = resolve; });
      }
      this.readerDone = true;
      this.wakeFlush();
      await flushed;
    } else {
      await response.body?.cancel().catch(() => {});
    }
    if (this.finished) return;
    this.responseEnded = true;
    this.host.sendFrame({ type: 'end', stream: this.id });
    if (this.requestEnded) this.settle();
    else this.reset(RESET.cancelled);
  }

  /** One `DATA` per pace slot, holding everything ready, so an SSE replay is not one frame per event. */
  private async flush(): Promise<void> {
    while (!this.finished) {
      if (this.outgoingBytes === 0) {
        if (this.readerDone) return;
        await new Promise<void>((resolve) => { this.flushWaiter = resolve; });
      } else if (this.sendWindow === 0) {
        await new Promise<void>((resolve) => { this.windowWaiter = resolve; });
      } else {
        await this.host.dataSlot();
        if (!this.finished) this.sendReady();
      }
    }
  }

  private sendReady(): void {
    const ready = Buffer.concat(this.outgoing);
    const size = Math.min(ready.length, this.sendWindow, this.host.maxData);
    this.sendWindow -= size;
    this.outgoingBytes -= size;
    this.outgoing = size < ready.length ? [ready.subarray(size)] : [];
    this.host.sendFrame({ type: 'data', stream: this.id, data: ready.subarray(0, size) });
    if (this.outgoingBytes < OUTGOING_LIMIT) this.wakeDrained();
  }

  private wakeFlush(): void {
    const wake = this.flushWaiter;
    this.flushWaiter = undefined;
    wake?.();
  }

  private wakeDrained(): void {
    const wake = this.drained;
    this.drained = undefined;
    wake?.();
  }

  receive(frame: StreamFrame): void {
    switch (frame.type) {
      case 'data': this.onData(frame.data); break;
      case 'end': this.onEnd(); break;
      case 'reset': this.abort(); this.host.streamDone(this.id); break;
      case 'window': this.onWindow(frame.increment); break;
    }
  }

  private onData(data: Buffer): void {
    if (data.length === 0) return;
    if (!this.bodyController) {
      this.reset(RESET.badRequest);
      return;
    }
    if (this.requestEnded) throw new Error('DATA after END');
    if (data.length > this.recvWindow) {
      this.reset(RESET.flowControl);
      return;
    }
    this.recvWindow -= data.length;
    this.received += data.length;
    if (this.expectedLength !== undefined && this.received > this.expectedLength) {
      this.reset(RESET.badRequest);
      return;
    }
    this.chunks.push(data);
    this.wakeBody();
  }

  private onEnd(): void {
    if (!this.bodyController) return;
    if (this.requestEnded) throw new Error('END twice');
    if (this.expectedLength !== undefined && this.received !== this.expectedLength) {
      this.reset(RESET.badRequest);
      return;
    }
    this.requestEnded = true;
    this.wakeBody();
    if (this.responseEnded) this.settle();
  }

  private wakeBody(): void {
    const wake = this.bodyWake;
    this.bodyWake = undefined;
    wake?.();
  }

  private onWindow(increment: number): void {
    if (increment > STREAM_WINDOW || this.sendWindow + increment > STREAM_WINDOW) {
      this.reset(RESET.flowControl);
      return;
    }
    this.sendWindow += increment;
    const wake = this.windowWaiter;
    this.windowWaiter = undefined;
    wake?.();
  }

  private settle(): void {
    if (this.finished) return;
    this.teardown();
    this.host.streamDone(this.id);
  }

  private reset(code: number): void {
    if (this.finished) return;
    this.host.sendFrame({ type: 'reset', stream: this.id, code });
    this.abort();
    this.host.streamDone(this.id);
  }

  /** Stops reading and cancels whatever is producing, so an SSE handler sees its stream abort. */
  abort(): void {
    if (this.finished) return;
    this.teardown();
    this.aborter.abort();
    try {
      this.bodyController?.error(new Error('stream reset'));
    } catch {
      // Already closed.
    }
    void this.reader?.cancel().catch(() => {});
  }

  private teardown(): void {
    this.finished = true;
    this.chunks = [];
    this.outgoing = [];
    this.wakeBody();
    this.wakeFlush();
    this.wakeDrained();
    const wake = this.windowWaiter;
    this.windowWaiter = undefined;
    wake?.();
  }
}
