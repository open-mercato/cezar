import assert from 'node:assert/strict';
import test from 'node:test';
import { NO_HTTP, screenFor } from '../connect/screens.js';

const saved = { id: 'a', url: 'https://cezar.example.com', username: 'me' };

test('an http address names the three https ways in', () => {
  const screen = screenFor({ screen: 'cleartext-refused', servers: [] }, { url: 'http://x' });
  assert.equal(screen.name, 'add');
  assert.equal(screen.notice, NO_HTTP);
  for (const way of ['ngrok', 'Cloudflare Tunnel', 'tailscale serve']) assert.ok(screen.notice.includes(way));
});

test('a rejected password returns to the sign-in form with the saved username', () => {
  const screen = screenFor({ screen: 'password-rejected', serverId: 'a', servers: [saved] });
  assert.deepEqual(screen, { name: 'credentials', url: saved.url, username: 'me', notice: 'Password rejected.' });
});

test('a saved server that cannot be reached offers Retry and Servers', () => {
  const screen = screenFor({ screen: 'connection-error', serverId: 'a', status: 0, servers: [saved] });
  assert.equal(screen.name, 'error');
  assert.equal(screen.serverId, 'a');
});

test('an unsaved server that cannot be reached stays on the add form', () => {
  assert.equal(screenFor({ screen: 'connection-error', servers: [] }, { url: 'https://x' }).name, 'add');
});

test('local mode explains itself', () => {
  assert.match(screenFor({ screen: 'local-mode', servers: [] }).notice, /CEZ_REMOTE=1/);
});

test('not-cezar says the status', () => {
  assert.match(screenFor({ screen: 'not-cezar', status: 500, servers: [] }).notice, /status 500/);
});

test('an empty list goes to the add form, and an unknown screen fails safe to the list', () => {
  assert.equal(screenFor({ screen: 'list', servers: [] }).name, 'add');
  assert.equal(screenFor({ screen: 'later-thing', servers: [saved] }).name, 'list');
});

test('open and login leave the page waiting for the server view', () => {
  assert.equal(screenFor({ screen: 'open', servers: [saved] }).name, 'busy');
  assert.equal(screenFor({ screen: 'login', servers: [] }).name, 'busy');
});
