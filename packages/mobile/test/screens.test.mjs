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

test('an empty list goes to the first screen where pairing exists, else the add form', () => {
  assert.equal(screenFor({ screen: 'list', servers: [], pairing: true }).name, 'start');
  assert.equal(screenFor({ screen: 'list', servers: [] }).name, 'add');
});

test('an unknown screen fails safe to the list', () => {
  assert.equal(screenFor({ screen: 'later-thing', servers: [saved] }).name, 'list');
});

test('open and login leave the page waiting for the server view', () => {
  assert.equal(screenFor({ screen: 'open', servers: [saved] }).name, 'busy');
  assert.equal(screenFor({ screen: 'login', servers: [] }).name, 'busy');
});

const paired = { id: 'r', url: 'https://relay.example.test', label: 'Laptop', relay: true };

test('a relay outage never reads as a problem with the computer', () => {
  assert.match(screenFor({ screen: 'relay-down', serverId: 'r', servers: [paired] }).message, /Your computer is fine/);
  assert.match(screenFor({ screen: 'cezar-offline', serverId: 'r', servers: [paired] }).message, /asleep/);
});

test('a removed phone gets its own screen, not a connection error', () => {
  assert.deepEqual(screenFor({ screen: 'device-removed', serverId: 'r', servers: [paired] }), { name: 'removed', serverId: 'r', label: 'Laptop' });
});

test('pairing phases', () => {
  assert.equal(screenFor({ screen: 'pair', phase: 'connecting', seq: 1 }).name, 'pair-waiting');
  assert.deepEqual(screenFor({ screen: 'pair', phase: 'confirm', seq: 2, digits: '518255', label: 'Mac' }), { name: 'pair-confirm', digits: '518255', label: 'Mac', seq: 2 });
});

test('every pairing failure says something, and an unknown one still does', () => {
  assert.match(screenFor({ screen: 'pair', phase: 'failed', reason: 'taken' }).message, /Someone else/);
  assert.match(screenFor({ screen: 'pair', phase: 'failed', reason: 'later-thing' }).message, /Pairing failed/);
});

test('quota names the wait', () => {
  assert.match(screenFor({ screen: 'quota', status: 12, serverId: 'r', servers: [paired] }).message, /12 minutes/);
});
