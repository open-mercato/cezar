// The demo's pairing page: cezar's own Connect a phone routes (spec 2026-11-01-relay-qr-pairing),
// called same-origin through Caddy, so the browser's Basic login is the only credential. No state
// lives here; cezar owns the pairing, its 2-minute life and its 5-an-hour limit.
'use strict';

const API = '/api/v1/workspace/phones';
const POLL_MS = 1500;

const FAILURES = {
  'device-limit': 'The relay cannot take another phone for this server. Try again after the nightly reset.',
  'relay-error': 'The relay did not confirm the phone, so it was not added. Show a new code.',
  timeout: 'Nobody answered in time. Show a new code.',
  cancelled: 'The pairing was cancelled. Show a new code.',
  contested: 'A second phone tried the same code, so it was cancelled. Show a new code.',
  'bad-payload': 'The phone sent something cezar cannot read. Update the app.',
  'tunnel-unsupported': 'This app and this cezar need updating to work together.',
  'phone-left': 'The phone went away before pairing finished. Show a new code.',
};

const $ = (id) => document.getElementById(id);
let pairingId = null;
let expiresAt = 0;
let pollTimer = null;
let tickTimer = null;

function say(text) {
  $('status').textContent = text;
}

async function call(method, path) {
  const res = await fetch(API + path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // An empty or non-JSON answer is reported by status alone.
  }
  return { res, body };
}

function stop(message) {
  clearTimeout(pollTimer);
  clearInterval(tickTimer);
  pollTimer = null;
  tickTimer = null;
  pairingId = null;
  $('pairing').hidden = true;
  $('confirm').hidden = true;
  $('start').disabled = false;
  $('start').textContent = 'Show a new code';
  if (message) say(message);
}

function tick() {
  const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  $('countdown').textContent = left > 0 ? `Type it in the app within ${left} s.` : 'This code has expired.';
}

async function start() {
  $('start').disabled = true;
  say('Asking cezar for a code…');
  try {
    const started = await call('POST', '/pairing');
    if (!started.res.ok) {
      const retry = Number(started.res.headers.get('retry-after'));
      const wait = retry > 0 ? ` Try again in about ${Math.ceil(retry / 60)} min.` : '';
      stop(`${started.body?.error ?? `cezar answered ${started.res.status}.`}${wait}`);
      return;
    }
    pairingId = started.body.id;
    expiresAt = Date.parse(started.body.expiresAt);
    const coded = await call('POST', `/pairing/${encodeURIComponent(pairingId)}/code`);
    if (!coded.res.ok) {
      stop(coded.body?.error ?? 'cezar could not open a typed code. Show a new code.');
      return;
    }
    $('code').textContent = coded.body.code;
    $('relay').textContent = coded.body.relayOrigin;
    $('pairing').hidden = false;
    say('Waiting for the app…');
    tick();
    tickTimer = setInterval(tick, 1000);
    poll();
  } catch {
    stop('Could not reach cezar. Reload the page and try again.');
  }
}

async function poll() {
  clearTimeout(pollTimer);
  if (!pairingId) return;
  let view;
  try {
    const { res, body } = await call('GET', '');
    if (!res.ok) throw new Error(String(res.status));
    view = body.pairing;
  } catch {
    pollTimer = setTimeout(poll, POLL_MS * 2);
    return;
  }
  if (!pairingId) return;
  if (!view || view.id !== pairingId) {
    stop('This pairing ended, perhaps because a new code was shown elsewhere. Show a new code.');
    return;
  }
  render(view);
  if (pairingId) pollTimer = setTimeout(poll, POLL_MS);
}

function render(view) {
  switch (view.status) {
    case 'waiting':
      say('Waiting for the app…');
      return;
    case 'handshaking':
      $('pairing').hidden = true;
      say('The app found this server. Waiting for its number…');
      return;
    case 'confirm':
      $('pairing').hidden = true;
      $('confirm').hidden = false;
      $('digits').textContent = view.digits ?? '';
      $('phone').textContent = view.phone ? ` (${view.phone.name})` : '';
      $('approve').disabled = false;
      $('deny').disabled = false;
      say('');
      return;
    case 'approving':
      $('confirm').hidden = true;
      say('Approving…');
      return;
    case 'approved':
      stop('Paired. The app now opens this demo through the relay.');
      return;
    case 'denied':
      stop('Denied. The phone was not added.');
      return;
    case 'expired':
      stop('The code expired before the app used it. Show a new code.');
      return;
    case 'cancelled':
      stop('The pairing was cancelled. Show a new code.');
      return;
    default:
      stop(FAILURES[view.failure] ?? 'Pairing failed. Show a new code.');
  }
}

async function decide(approve) {
  if (!pairingId) return;
  $('approve').disabled = true;
  $('deny').disabled = true;
  const { res, body } = await call('POST', `/pairing/${encodeURIComponent(pairingId)}/${approve ? 'approve' : 'deny'}`).catch(() => ({ res: { ok: false }, body: null }));
  if (!res.ok) say(body?.error ?? 'cezar did not take the answer.');
  poll();
}

document.addEventListener('DOMContentLoaded', () => {
  $('start').addEventListener('click', start);
  $('approve').addEventListener('click', () => decide(true));
  $('deny').addEventListener('click', () => decide(false));
  // A phone-only reviewer switches to the app and back: refresh at once rather than on the next tick.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pairingId) poll();
  });
});
