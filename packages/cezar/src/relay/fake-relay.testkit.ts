import { RELAY_TERMS, type RelayAccountStatus } from '@open-mercato/cezar-contract';
import type { AccountPost } from './account.ts';
import type { RelaySocket, SocketFactory, SocketHandlers, SocketRefusal } from './socket.ts';
import { fromB64u, relayId } from './wire.ts';

const GRACE_S = 48 * 3600;

interface FakeAttachment {
  account: string | undefined;
  email: string | undefined;
  confirmed: boolean;
  graceFrom: number;
  epoch: number;
  termsVersion: string | undefined;
  acceptedAt: number | undefined;
}

/**
 * Rome's account model (RELAY_PROTOCOL.md § 18), small enough to read: attachments per `cezarId`,
 * one code each, the 48 h grace. Proofs are trusted, the key only names the cezar.
 */
export class FakeAccounts {
  nowS = () => Math.floor(Date.now() / 1000);
  /** `TERMS_VERSION`, when the relay pins one. */
  termsVersion: string | undefined;
  /** A relay older than § 18: every account route is 404 `no-route`. */
  unsupported = false;
  readonly calls: { path: string; body: Record<string, unknown> }[] = [];
  readonly attachments = new Map<string, FakeAttachment>();
  readonly codes = new Map<string, string>();
  readonly devices = new Map<string, string[]>();
  private nextAccount = 1;

  /** First sighting writes the anonymous grace row, as § 18 Enforcement rule 3 does. */
  sight(cezarId: string): FakeAttachment {
    let row = this.attachments.get(cezarId);
    if (!row) {
      row = { account: undefined, email: undefined, confirmed: false, graceFrom: this.nowS(), epoch: 0, termsVersion: undefined, acceptedAt: undefined };
      this.attachments.set(cezarId, row);
    }
    return row;
  }

  status(cezarId: string): RelayAccountStatus {
    const row = this.attachments.get(cezarId);
    const ends = (row?.graceFrom ?? this.nowS()) + GRACE_S;
    const confirmed = row?.confirmed === true;
    const left = Math.max(0, ends - this.nowS());
    return {
      state: confirmed ? 'confirmed' : left > 0 ? 'pending' : 'blocked',
      email: row?.email ?? null,
      termsVersion: row?.termsVersion ?? null,
      acceptedAt: row?.acceptedAt ?? null,
      confirmedAt: confirmed ? row!.graceFrom : null,
      graceEndsAt: confirmed ? null : ends,
      secondsLeft: confirmed ? null : left,
    };
  }

  /** `undefined` lets the socket in; otherwise the 4451 reason. */
  gate(cezarId: string): string | undefined {
    const status = this.status(cezarId);
    if (status.state !== 'blocked') return undefined;
    return this.attachments.get(cezarId)?.account ? 'email-unconfirmed' : 'account-required';
  }

  hasAccount(cezarId: string): boolean {
    return this.attachments.get(cezarId)?.account !== undefined;
  }

  /** Back-dates the grace, so a test can stand after it. */
  age(cezarId: string, seconds: number): void {
    this.sight(cezarId).graceFrom -= seconds;
  }

  readonly post: AccountPost = async (url, { headers, body }) => {
    const path = new URL(url).pathname;
    const json = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
    this.calls.push({ path, body: json });
    const answer = (status: number, payload: unknown = {}) => ({ status, json: payload });
    if (this.unsupported) return answer(404, { code: 'no-route' });
    const key = fromB64u(headers['X-Cezar-Relay-Key'] ?? '', 32);
    const cezarId = key ? relayId(key) : undefined;
    const tokenOk = (token: unknown) => {
      const row = cezarId ? this.attachments.get(cezarId) : undefined;
      return row?.account !== undefined && token === `tok.${cezarId}.${row.epoch}`;
    };
    switch (path) {
      case '/v1/accounts': {
        if (!cezarId) return answer(401, { code: 'bad-proof' });
        if (json.accepted !== true) return answer(451, { code: 'terms-required' });
        if (this.termsVersion && json.termsVersion !== this.termsVersion) return answer(409, { code: 'terms-outdated', current: this.termsVersion });
        const email = String(json.email).trim().toLowerCase();
        const row = this.sight(cezarId);
        if (row.email !== email) {
          if (row.account === undefined) row.graceFrom = this.nowS(); // Moved forward once, to the first attachment.
          row.account = `acc${this.nextAccount++}`;
          row.email = email;
          row.confirmed = false;
          row.epoch += 1;
        }
        row.termsVersion = String(json.termsVersion);
        row.acceptedAt = this.nowS();
        let codeSent = false;
        if (!row.confirmed) {
          this.codes.set(cezarId, String(100000 + this.calls.length));
          codeSent = true;
        }
        return answer(200, { account: row.account, token: `tok.${cezarId}.${row.epoch}`, status: this.status(cezarId), codeSent });
      }
      case '/v1/accounts/status':
        if (!cezarId) return answer(401, { code: 'bad-proof' });
        return answer(200, { account: this.attachments.get(cezarId)?.account ?? null, status: this.status(cezarId) });
      case '/v1/accounts/resend': {
        if (!cezarId || !tokenOk(json.token)) return answer(401, { code: 'bad-token' });
        if (this.attachments.get(cezarId)!.confirmed) return answer(409, { code: 'already-confirmed' });
        this.codes.set(cezarId, String(100000 + this.calls.length));
        return answer(200, { expiresAt: this.nowS() + 900 });
      }
      case '/v1/accounts/confirm': {
        const target = String(json.cezar);
        const code = this.codes.get(target);
        if (!code) return answer(410, { code: 'code-expired' });
        if (code !== json.code) return answer(400, { code: 'bad-code' });
        this.codes.delete(target);
        this.attachments.get(target)!.confirmed = true;
        return answer(200, { status: this.status(target) });
      }
      case '/v1/accounts/devices':
        if (!cezarId || !tokenOk(json.token)) return answer(401, { code: 'bad-token' });
        this.devices.set(cezarId, json.devices as string[]);
        return answer(204);
      case '/v1/accounts/delete':
        return answer(202);
      default:
        return answer(404, { code: 'no-route' });
    }
  };

  /** The code the last email carried. */
  codeFor(cezarId: string): string | undefined {
    return this.codes.get(cezarId);
  }
}

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
  /** A hostile relay: `device-remove` is acked and does nothing. */
  swallowRemovals = false;
  allowlist = new Set<string>();
  readonly accounts = new FakeAccounts();
  /** § 18 gating on sockets, rendezvous and `device-add`. Off, the relay is as before accounts. */
  enforceAccounts = false;
  /** Send a 4451's reason in the close frame only, with no `error` frame first. */
  reasonInCloseOnly = false;
  /** The headers of the latest cezar socket, to see the account token. */
  cezarHeaders: Record<string, string> = {};
  private cezarId: string | undefined;
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

  readonly open: SocketFactory = (url, headers, handlers) => {
    this.opened.push(url);
    const refusal = this.refuse?.(url);
    if (refusal) {
      later(() => handlers.onRefused(refusal));
      return { send: () => {}, close: () => {}, terminate: () => {} };
    }
    const path = new URL(url);
    const [, , role, id, device] = path.pathname.split('/') as [string, string, string, string, string | undefined];
    if (role === 'cezar') {
      this.cezarHeaders = headers;
      this.cezarId = id;
      if (this.enforceAccounts) {
        const reason = this.accounts.gate(id);
        if (reason) return this.refuseAccount(handlers, reason);
        this.accounts.sight(id);
      }
      return this.openCezar(handlers);
    }
    if (role === 'pair' && this.enforceAccounts && path.searchParams.get('role') === 'cezar') {
      const key = fromB64u(headers['X-Cezar-Relay-Key'] ?? '', 32);
      if (!key || !this.accounts.hasAccount(relayId(key))) {
        later(() => handlers.onRefused({ status: 451, code: 'terms-required' }));
        return { send: () => {}, close: () => {}, terminate: () => {} };
      }
    }
    if (role === 'phone') return this.openPhone(device ?? id, handlers);
    return this.openPair(id, path.searchParams.get('role') === 'phone', handlers);
  };

  /** § 18: accepted, one `error` frame, then 4451, because a phone cannot read an HTTP refusal. */
  private refuseAccount(handlers: SocketHandlers, reason: string): RelaySocket {
    const end = this.end(handlers, () => {}, () => {});
    later(() => {
      if (this.reasonInCloseOnly) {
        end.closed = true;
        later(() => handlers.onClose(4451, reason));
        return;
      }
      handlers.onMessage(JSON.stringify({ t: 'error', code: reason }));
      end.socket.close(4451);
    });
    return end.socket;
  }

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
    const termsMissing = this.enforceAccounts && this.cezarId !== undefined && !this.accounts.hasAccount(this.cezarId);
    const adds = frame.t === 'device-add' ? (frame.device && !this.allowlist.has(frame.device))
      : frame.t === 'device-sync' && (frame.devices ?? []).some((row) => !this.allowlist.has(row.device));
    if (termsMissing && adds) {
      const cezar = this.cezar;
      later(() => cezar?.handlers.onMessage(JSON.stringify({ t: 'error', id: frame.id, code: 'terms-required' })));
      return;
    }
    if (frame.t === 'device-sync') this.allowlist = new Set(frame.devices?.map((row) => row.device));
    if (frame.t === 'device-add' && frame.device) this.allowlist.add(frame.device);
    if (frame.t === 'device-remove' && frame.device && !this.swallowRemovals) {
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

/** § 18 gates a code on an account, so pairing tests attach one first. A refused attach falls through to the start's own refusal. */
export async function startWithAccount(service: {
  accountLocal(): { attached: boolean };
  refreshAddress?(): Promise<void>;
  setAccount(email: string, termsVersion: string): Promise<unknown>;
  startPairing(): Promise<{ id: string; qr: string; relayOrigin: string; expiresAt: string }>;
}): Promise<{ id: string; qr: string; relayOrigin: string; expiresAt: string }> {
  await service.refreshAddress?.();
  if (!service.accountLocal().attached) await service.setAccount('me@example.test', RELAY_TERMS.version).catch(() => undefined);
  return service.startPairing();
}
