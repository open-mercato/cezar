import type { RelaySocket, SocketFactory, SocketHandlers, SocketRefusal } from './socket.ts';

/**
 * A plain fake socket with just enough routing to join two tests' ends. It records every frame the
 * cezar socket sends. It is a test double, not a relay: no limit, proof or storage lives here.
 */

interface End {
  handlers: SocketHandlers;
  socket: RelaySocket;
  closed: boolean;
}

interface Rendezvous {
  cezar: End;
  phone?: End;
  burned: boolean;
}

const later = (fn: () => void) => { queueMicrotask(fn); };

export class FakeRelay {
  /** Every frame sent by the cezar socket, text as text, binary as `Buffer`. */
  readonly cezarFrames: (string | Buffer)[] = [];
  readonly opened: string[] = [];
  hello: Record<string, unknown> = { limits: { frameBytes: 65_552, controlBytes: 8_192, devices: 10 } };
  rendezvousHello: Record<string, unknown> = { limits: { frameBytes: 16_384 } };
  /** Answer per command `t`: `ack`, an error code, or `silent`. */
  commands: Record<string, 'ack' | 'silent' | string> = {};
  refuse: ((url: string) => SocketRefusal | undefined) | undefined;
  allowlist = new Set<string>();
  private cezar: End | undefined;
  private readonly phones = new Map<string, End>();
  private readonly rendezvous = new Map<string, Rendezvous>();

  private end(handlers: SocketHandlers, onSend: (data: string | Buffer, end: End) => void, onClose: (end: End) => void): End {
    const end: End = {
      handlers,
      closed: false,
      socket: {
        send: (data) => {
          if (data === 'ping') {
            later(() => { if (!end.closed) handlers.onMessage('pong'); });
            onSend(data, end);
            return;
          }
          onSend(data, end);
        },
        close: (code) => this.shut(end, code, onClose),
        terminate: () => this.shut(end, 1006, onClose),
      },
    };
    return end;
  }

  private shut(end: End, code: number, onClose: (end: End) => void): void {
    if (end.closed) return;
    end.closed = true;
    later(() => end.handlers.onClose(code));
    onClose(end);
  }

  readonly open: SocketFactory = (url, _headers, handlers) => {
    this.opened.push(url);
    const refusal = this.refuse?.(url);
    if (refusal) {
      later(() => handlers.onRefused(refusal));
      return { send: () => {}, close: () => {}, terminate: () => {} };
    }
    const path = new URL(url);
    const [, , role, id, device] = path.pathname.split('/') as [string, string, string, string, string | undefined];
    if (role === 'cezar') return this.openCezar(handlers);
    if (role === 'phone') return this.openPhone(device ?? id, handlers);
    return this.openPair(id, path.searchParams.get('role') === 'phone', handlers);
  };

  private openCezar(handlers: SocketHandlers): RelaySocket {
    const end = this.end(handlers, (data) => this.fromCezar(data), () => {
      this.cezar = undefined;
      for (const phone of this.phones.values()) later(() => phone.handlers.onMessage(JSON.stringify({ t: 'cezar-offline' })));
    });
    this.cezar = end;
    later(() => handlers.onMessage(JSON.stringify({ t: 'hello', protocol: 1, ...this.hello, phones: [...this.phones.keys()] })));
    return end.socket;
  }

  private openPhone(deviceId: string, handlers: SocketHandlers): RelaySocket {
    if (!this.allowlist.has(deviceId)) {
      later(() => handlers.onRefused({ status: 403, code: 'device-removed' }));
      return { send: () => {}, close: () => {}, terminate: () => {} };
    }
    const end = this.end(handlers, (data) => {
      if (typeof data === 'string' || !this.cezar) return;
      const routed = Buffer.concat([Buffer.from([1]), Buffer.from(deviceId, 'base64url'), data.subarray(1)]);
      const cezar = this.cezar;
      later(() => cezar.handlers.onMessage(routed));
    }, () => {
      this.phones.delete(deviceId);
      const cezar = this.cezar;
      later(() => cezar?.handlers.onMessage(JSON.stringify({ t: 'phone-left', device: deviceId })));
    });
    this.phones.set(deviceId, end);
    later(() => handlers.onMessage(JSON.stringify({ t: 'hello', protocol: 1, cezar: this.cezar ? 'online' : 'offline' })));
    const cezar = this.cezar;
    later(() => cezar?.handlers.onMessage(JSON.stringify({ t: 'phone-joined', device: deviceId })));
    return end.socket;
  }

  private fromCezar(data: string | Buffer): void {
    this.cezarFrames.push(data);
    if (typeof data !== 'string') {
      const device = data.subarray(1, 17).toString('base64url');
      const phone = this.phones.get(device);
      const bare = Buffer.concat([Buffer.from([1]), data.subarray(17)]);
      later(() => { if (phone && !phone.closed) phone.handlers.onMessage(bare); });
      return;
    }
    if (data === 'ping') return;
    const frame = JSON.parse(data) as { t: string; id: string; device?: string; devices?: { device: string }[] };
    if (frame.t === 'device-sync') this.allowlist = new Set(frame.devices?.map((row) => row.device));
    if (frame.t === 'device-add' && frame.device) this.allowlist.add(frame.device);
    if (frame.t === 'device-remove' && frame.device) {
      this.allowlist.delete(frame.device);
      const phone = this.phones.get(frame.device);
      if (phone) phone.socket.close(4403);
    }
    const answer = this.commands[frame.t] ?? 'ack';
    if (answer === 'silent') return;
    const reply = answer === 'ack' ? { t: 'ack', id: frame.id } : { t: 'error', id: frame.id, code: answer };
    const cezar = this.cezar;
    later(() => cezar?.handlers.onMessage(JSON.stringify(reply)));
  }

  private openPair(locator: string, phone: boolean, handlers: SocketHandlers): RelaySocket {
    const room = this.rendezvous.get(locator);
    if (!phone) return this.pairCezar(locator, room, handlers);
    if (!room) {
      later(() => handlers.onRefused({ status: 404, code: 'no-rendezvous' }));
      return { send: () => {}, close: () => {}, terminate: () => {} };
    }
    if (room.burned) {
      later(() => room.cezar.handlers.onMessage(JSON.stringify({ t: 'pair-contested' })));
      later(() => handlers.onRefused({ status: 409, code: 'pair-taken' }));
      return { send: () => {}, close: () => {}, terminate: () => {} };
    }
    room.burned = true;
    const end = this.end(handlers, (data) => {
      if (typeof data !== 'string') later(() => { if (!room.cezar.closed) room.cezar.handlers.onMessage(data); });
    }, () => {
      later(() => { if (!room.cezar.closed) room.cezar.handlers.onMessage(JSON.stringify({ t: 'peer-left' })); });
    });
    room.phone = end;
    later(() => handlers.onMessage(JSON.stringify({ t: 'hello', protocol: 1, ...this.rendezvousHello })));
    later(() => {
      for (const party of [room.cezar, end]) party.handlers.onMessage(JSON.stringify({ t: 'peer-joined' }));
    });
    return end.socket;
  }

  private pairCezar(locator: string, room: Rendezvous | undefined, handlers: SocketHandlers): RelaySocket {
    if (room) {
      later(() => handlers.onRefused({ status: 409, code: 'pair-taken' }));
      return { send: () => {}, close: () => {}, terminate: () => {} };
    }
    const created: Rendezvous = { burned: false, cezar: undefined as unknown as End };
    created.cezar = this.end(handlers, (data) => {
      if (typeof data !== 'string') later(() => { if (created.phone && !created.phone.closed) created.phone.handlers.onMessage(data); });
    }, () => {
      this.rendezvous.delete(locator);
      const phone = created.phone;
      later(() => { if (phone && !phone.closed) phone.handlers.onMessage(JSON.stringify({ t: 'peer-left' })); });
    });
    this.rendezvous.set(locator, created);
    later(() => handlers.onMessage(JSON.stringify({ t: 'hello', protocol: 1, ...this.rendezvousHello })));
    return created.cezar.socket;
  }

  /** Close the cezar socket from the relay's side. */
  closeCezar(code: number): void {
    this.cezar?.socket.close(code);
  }

  get cezarConnected(): boolean {
    return this.cezar !== undefined;
  }

  /** Bytes from a phone-shaped sender to cezar: a hostile relay's injection. */
  inject(deviceId: string, ciphertext: Buffer): void {
    this.cezar?.handlers.onMessage(Buffer.concat([Buffer.from([1]), Buffer.from(deviceId, 'base64url'), ciphertext]));
  }

  control(frame: Record<string, unknown>): void {
    this.cezar?.handlers.onMessage(JSON.stringify(frame));
  }
}
