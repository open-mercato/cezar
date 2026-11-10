import type { ClientRequest, IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';

/** The one seam tests replace: a plain fake socket, so no relay implementation enters this repo. */
export interface RelaySocket {
  send(data: string | Buffer): void;
  close(code: number): void;
  terminate(): void;
}

export interface SocketRefusal {
  status: number;
  code?: string;
  retryAfter?: number;
  date?: string;
}

export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: string | Buffer): void;
  onClose(code: number): void;
  onRefused(refusal: SocketRefusal): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>, handlers: SocketHandlers) => RelaySocket;

const HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_PAYLOAD_BYTES = 70_000;
const MAX_REFUSAL_BYTES = 1_024;

function readRefusal(request: ClientRequest, response: IncomingMessage, deliver: (refusal: SocketRefusal) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  const finish = () => {
    let code: string | undefined;
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { code?: unknown };
      if (typeof parsed.code === 'string') code = parsed.code;
    } catch {
      // A body that is not ours falls back to the status, § 3.2.
    }
    const retryAfter = Number(response.headers['retry-after']);
    deliver({
      status: response.statusCode ?? 0,
      ...(code ? { code } : {}),
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}),
      ...(response.headers.date ? { date: response.headers.date } : {}),
    });
    request.destroy();
  };
  response.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size <= MAX_REFUSAL_BYTES) chunks.push(chunk);
  });
  response.once('end', finish);
  response.once('error', finish);
}

/** `perMessageDeflate` stays off: § 3 forbids offering it. */
export const openWebSocket: SocketFactory = (url, headers, handlers) => {
  const socket = new WebSocket(url, {
    headers,
    perMessageDeflate: false,
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  let refused = false;
  socket.on('open', () => handlers.onOpen());
  socket.on('message', (data, isBinary) => {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
    handlers.onMessage(isBinary ? bytes : bytes.toString('utf8'));
  });
  socket.on('unexpected-response', (request, response) => {
    refused = true;
    readRefusal(request, response, (refusal) => handlers.onRefused(refusal));
  });
  socket.on('error', () => {
    // The `close` that follows carries 1006, which reads as network loss.
  });
  socket.on('close', (code) => {
    if (!refused) handlers.onClose(code);
  });
  return {
    send: (data) => socket.send(data),
    close: (code) => socket.close(code),
    terminate: () => socket.terminate(),
  };
};
