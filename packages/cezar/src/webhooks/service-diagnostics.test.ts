import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
// Run production service + real package-local undici in isolation. Only the
// socket route and DNS answer are substituted; no public traffic is sent.
const client = `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const net = require('node:net'), connect = net.connect;
const mode = process.argv[2];
const late = mode.startsWith('late');
const inflight = mode.startsWith('inflight');
const overlap = 'synthetic-overlapping-credential';
process.env.TEST_DIAGNOSTIC_SECRET = overlap;
const secretUrl = 'https://other.invalid/hooks/' + (mode.includes('long') ? 'x'.repeat(500) : overlap) + '/private-tail?value=private-capability';
let service, other, captured, signed, keys, body;
let requests = 0;
const server = createServer((req, res) => {
  let bytes = ''; req.setEncoding('utf8'); req.on('data', chunk => bytes += chunk);
  req.on('end', async () => {
    try {
      assert.equal(req.headers['webhook-signature'], signed(req.headers['webhook-id'], Number(req.headers['webhook-timestamp']), bytes, keys));
      assert.equal(req.headers['webhook-signature'].split(' ').length, mode === 'rotation' ? 2 : 1);
      body = bytes;
      if (++requests > 1) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('control diagnostic'); return; }
      let extra = '';
      if (mode === 'rotation') {
        const rotated = await service.rotate(other.receiver.id, other.receiver.revision, 'graceful');
        extra = ' ' + rotated.secret;
      }
      if (inflight) {
        let added = await service.create({ name: 'Intermediate receiver', url: secretUrl });
        if (mode === 'inflight-delete') await service.delete(added.receiver.id, added.receiver.revision);
        if (mode === 'inflight-update' || mode === 'inflight-repeated') {
          for (let i = 0; i < (mode === 'inflight-repeated' ? 80 : 1); i++) {
            added = { receiver: await service.update(added.receiver.id, { expectedRevision: added.receiver.revision, name: 'Updated', url: 'https://replacement.invalid/' + i }) };
          }
        }
      }
      res.writeHead(429, { 'content-type': secretUrl, 'retry-after': '60' });
      res.end('diagnostic ' + secretUrl + extra);
    } catch (error) { res.destroy(error); }
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
net.connect = function(options, ...rest) { return connect.call(this, { ...options, host: '127.0.0.1', port, lookup: undefined }, ...rest); };
const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-service-diagnostics-'));
execFileSync('git', ['init', '-q'], { cwd: root });
const base = process.argv[1];
const { WebhookService } = await import(base + 'service.ts');
const { WebhookScheduler } = await import(base + 'scheduler.ts');
const transport = await import(base + 'transport.ts');
const { sendWebhook } = transport;
const { signWebhook } = await import(base + 'signing.ts');
signed = signWebhook;
process.env.CEZ_WEBHOOKS = '1';
try {
  service = await WebhookService.open({ root, dataDir: root + '/.ai/cezar', projectId: 'synthetic', mode: 'local', serverPorts: () => [], scheduler: new WebhookScheduler(), send: async input => {
    keys = input.secrets;
    captured = await sendWebhook(input, { lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
    // Add after transport redaction, before serialized durable completion. This
    // specifically catches implementations that re-redact an already masked URL.
    if (late && requests === 1) await service.create({ name: 'Late receiver', url: secretUrl });
    return captured;
  } });
  let a = await service.create({ name: 'Public receiver', url: 'http://receiver.invalid:' + port + '/' });
  if (!late && !inflight) other = await service.create({ name: 'Other receiver', url: secretUrl });
  if (mode === 'rotation') a = await service.rotate(a.receiver.id, a.receiver.revision, 'graceful');
  await service.test(a.receiver.id, { expectedRevision: a.receiver.revision, deliveryRevision: a.receiver.deliveryRevision, operationId: 'diagnostic-test' });
  await service.tick();
  const row = service.deliveryPage(a.receiver.id, { limit: 100 }).items[0];
  assert.equal(row.httpStatus, 429);
  assert.equal(row.response, late || inflight || mode === 'rotation' ? undefined : 'diagnostic [REDACTED]');
  assert.equal(captured.retryAfter, '60');
  const omitted = transport.redactWebhookDiagnostics(captured, [], true);
  assert.deepEqual(omitted, { kind: 'http', status: 429, retryAfter: '60' });
  assert.equal(transport.retryAt(1, 0, omitted.retryAfter, () => 0), 60000);
  assert.equal(Object.getOwnPropertySymbols(captured).length, 0);
  assert.deepEqual(Object.getOwnPropertyNames(captured).sort(), ['contentType', 'kind', 'response', 'retryAfter', 'status']);
  if (!late && !inflight) assert.equal(captured.contentType, '[REDACTED]');
  const refreshed = transport.redactWebhookDiagnostics(captured, [secretUrl]);
  assert.equal(refreshed.contentType, '[REDACTED]', 'refresh uses complete original headers, before clipping or earlier masking');
  assert.equal(refreshed.retryAfter, '60');
  assert.equal(refreshed.status, 429);
  assert.equal(service.deliveries(a.receiver.id)[0].body, body, 'frozen signed body is unchanged');
  const directory = root + '/.ai/cezar/webhooks';
  const disk = readFileSync(directory + '/deliveries.ndjson', 'utf8') + readdirSync(directory + '/events').filter(n => n.endsWith('.json')).map(n => readFileSync(directory + '/events/' + n, 'utf8')).join('');
  assert(!disk.includes('private-tail'));
  assert(!disk.includes('private-capability'));
  const current = service.list().receivers.find(receiver => receiver.id === a.receiver.id);
  await service.test(current.id, { expectedRevision: current.revision, deliveryRevision: current.deliveryRevision, operationId: 'diagnostic-control' });
  await service.tick();
  assert(service.deliveryPage(a.receiver.id, { limit: 100 }).items.some(item => item.response === 'control diagnostic'), 'uncertainty ends with the attempt');
  console.log('safe diagnostics; original signing keys and frozen body preserved');
} finally {
  await service?.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); net.connect = connect; rmSync(root, { recursive: true, force: true });
}
`;

it.each(['registered', 'registered-long', 'late-overlap', 'late-long', 'rotation', 'inflight-delete', 'inflight-update', 'inflight-repeated'])(
  'redacts other receiver diagnostics at durable completion (%s)', async mode => {
    // The child is a full Node + tsx boot; a loaded CI host can exceed a tighter bound and report a
    // timeout as a diagnostics failure.
    const { stdout, stderr } = await exec(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', client,
      new URL('./', import.meta.url).href, mode,
    ], { timeout: 30000 });
    expect(stderr).toBe('');
    expect(stdout.trim()).toBe('safe diagnostics; original signing keys and frozen body preserved');
  }, 60000,
);
