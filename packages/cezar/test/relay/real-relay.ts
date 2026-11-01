// Drives cezar's relay client against a real relay under `wrangler dev`. Not part of any suite:
//   CEZ_RELAY_URL=http://127.0.0.1:8788 CEZ_HOME=<scratch> tsx test/relay/real-relay.ts <cockpit url>
// The cockpit must already be serving with the same CEZ_RELAY_URL and CEZ_HOME.
import { PhoneSim, type OpenStream } from '../../src/relay/phone-sim.testkit.ts';
import { openWebSocket } from '../../src/relay/socket.ts';

const cockpit = process.argv[2];
const idleSeconds = Number(process.argv[3] ?? '125');
if (!cockpit) throw new Error('usage: real-relay.ts <cockpit url> [idle seconds]');

const api = async (method: string, path: string, body?: unknown): Promise<any> => {
  const response = await fetch(`${cockpit}/api/v1${path}`, {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  console.log(`desktop ${method} ${path} -> ${response.status}`);
  if (!response.ok) throw new Error(text);
  return text ? JSON.parse(text) : null;
};
const log = (...args: unknown[]) => console.log(...args);
const redacted = { qr: '<redacted>', code: '<redacted>' };

const started = await api('POST', '/workspace/phones/pairing');
log('pairing started', { ...started, ...redacted });

const phone = new PhoneSim(openWebSocket, { name: 'Node sim', platform: 'android' });
const paired = await phone.pairWithQr(started.qr);
log('phone digits', paired.digits, 'pending label', paired.pending.label);
const view = (await api('GET', '/workspace/phones')).pairing;
log('desktop pairing', view.status, 'digits', view.digits, 'match', view.digits === paired.digits);
if (view.digits !== paired.digits) throw new Error('digits differ');
await api('POST', `/workspace/phones/pairing/${started.id}/approve`);
log('outcome', await phone.outcome(15_000));

await new Promise((resolve) => setTimeout(resolve, 500));
await phone.connect();
log('KK done, HELLO and LEASE sent');
const lease = setInterval(() => phone.lease(), 20_000);

const health = await phone.fetch('GET', '/api/v1/health', [['host', '127.0.0.1:4321']]);
const payload = JSON.parse(health.body.toString('utf8'));
log('GET /health', health.status, {
  localHandoff: payload.capabilities.localHandoff,
  terminal: payload.capabilities.terminal,
  phonePairing: payload.capabilities.phonePairing,
  repoRoot: payload.repoRoot,
});

const posted = await phone.fetch('PUT', '/api/v1/workspace/ui-state', [['content-type', 'application/json']], JSON.stringify({ relayProbe: 'hello through the tunnel' }));
log('PUT /workspace/ui-state with a body', posted.status, posted.body.toString('utf8').slice(0, 100));
const read = await phone.fetch('GET', '/api/v1/workspace/ui-state');
log('read back', read.status, JSON.parse(read.body.toString('utf8')).relayProbe);

const refused = await phone.fetch('GET', '/api/v1/workspace/phones');
log('GET /workspace/phones from the phone', refused.status);
const agentConfig = await phone.fetch('POST', '/api/v1/workspace/phones/pairing');
log('POST pairing from the phone', agentConfig.status);

const sse: OpenStream = phone.stream('GET', '/api/v1/workspace/events');
log('SSE head', (await sse.head).status);
log('SSE first bytes', JSON.stringify((await sse.next())?.slice(0, 40)));
await api('PATCH', `/workspace/phones/${phone.deviceId}`, { label: 'Renamed sim' });
const marker = await fetch(`${cockpit}/api/v1/projects`).then((r) => r.status);
log('desktop still serves', marker);
sse.reset();

const big = await phone.fetch('GET', '/');
log('GET / through the tunnel', big.status, big.body.length, 'bytes');

log(`idle: holding the session for ${idleSeconds} s; the relay should see only LEASE`);
await new Promise((resolve) => setTimeout(resolve, 5_000));
clearInterval(lease);
phone.closeSocket();
await new Promise((resolve) => setTimeout(resolve, 2_000));
log('phone socket closed; counting idle frames with no phone');
const before = await api('GET', '/workspace/phones');
log('relay', before.relay, 'phones', before.phones.map((p: any) => ({ label: p.label, connected: p.connected })));
await new Promise((resolve) => setTimeout(resolve, idleSeconds * 1000));

await phone.connect();
const lease2 = setInterval(() => phone.lease(), 20_000);
log('reconnected, new KK');
await api('DELETE', `/workspace/phones/${phone.deviceId}`);
await new Promise((resolve) => setTimeout(resolve, 2_000));
clearInterval(lease2);
const removed = phone.tunnelFrames.filter((f) => f.type === 'close');
log('phone got CLOSE', removed, 'socket closes', phone.closes);
try {
  await phone.connect();
  log('UNEXPECTED: removed phone connected');
} catch (error) {
  log('removed phone refused:', (error as Error).message);
}
const after = await api('GET', '/workspace/phones');
log('relay after last Remove', after.relay, 'phones', after.phones.length);
process.exit(0);
