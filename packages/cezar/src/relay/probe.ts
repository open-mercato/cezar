import type { RelayTestFailure, TestRelayAddressResponse } from '@open-mercato/cezar-contract';
import { randomBytes } from 'node:crypto';
import { limitsFrom } from './connection.ts';
import type { RelaySocket, SocketFactory, SocketRefusal } from './socket.ts';
import { RELAY_PROTOCOL_VERSION, RENDEZVOUS_FRAME_BYTES, b64u, proofHeaders, socketOrigin, socketProof } from './wire.ts';

const HELLO_TIMEOUT_MS = 10_000;

function refusalReason({ status, code }: SocketRefusal): RelayTestFailure {
  if (status === 0 || (status >= 500 && code !== 'relay-disabled')) return 'unreachable';
  if (status === 503) return 'disabled';
  if (status === 426) return 'incompatible';
  if (status === 429) return 'rate-limited';
  return status === 401 ? 'refused' : 'not-a-relay';
}

/**
 * Opens a throwaway rendezvous and reads `hello`, the only frame that states `protocol` (§ 14). With
 * nobody joining and nothing stored, it costs the relay one upgrade and one `rendezvousPerHour` of
 * `seed`'s key, never of this computer's.
 */
export function probeRelay(origin: string, open: SocketFactory, seed: Buffer): Promise<TestRelayAddressResponse> {
  const locator = b64u(randomBytes(32));
  const time = Math.floor(Date.now() / 1000);
  const headers = { ...proofHeaders(seed, socketProof('pair', locator, '-', time), time) };
  return new Promise((resolve) => {
    let socket: RelaySocket | undefined;
    let opened = false;
    let settled = false;
    const finish = (result: TestRelayAddressResponse, end?: (socket: RelaySocket) => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) end?.(socket);
      resolve(result);
    };
    const fail = (reason: RelayTestFailure, end?: (socket: RelaySocket) => void) => finish({ ok: false, reason }, end);
    const bye = (live: RelaySocket) => live.close(1000);
    const timer = setTimeout(() => fail(opened ? 'not-a-relay' : 'unreachable', (live) => live.terminate()), HELLO_TIMEOUT_MS);
    timer.unref?.();
    const onMessage = (data: string | Buffer) => {
      let frame: Record<string, unknown> | undefined;
      try {
        frame = typeof data === 'string' ? JSON.parse(data) as Record<string, unknown> : undefined;
      } catch {
        // Not a relay's first frame, which the line below says.
      }
      if (frame?.t !== 'hello') return fail('not-a-relay', bye);
      if (frame.protocol !== RELAY_PROTOCOL_VERSION) return fail('incompatible', bye);
      if (limitsFrom(frame).frameBytes < RENDEZVOUS_FRAME_BYTES) return fail('incompatible', bye);
      return finish({ ok: true, origin, protocol: RELAY_PROTOCOL_VERSION }, bye);
    };
    try {
      socket = open(`${socketOrigin(origin)}/v1/pair/${locator}?role=cezar`, headers, {
        onOpen: () => { opened = true; },
        onMessage,
        onClose: (code) => fail(code === 4426 ? 'incompatible' : opened ? 'not-a-relay' : 'unreachable'),
        onRefused: (refusal) => fail(refusalReason(refusal)),
      });
    } catch {
      fail('unreachable');
    }
  });
}
