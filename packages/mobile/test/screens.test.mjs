import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ACCOUNT_WHY, MAX_NAME, NO_HTTP, accountOpens, backTarget, cardFor, checkName, confirmLead, countLine, forgetLead, linkLine, lockRow, needWords, notificationsRow, orderServers, primaryFor, pushSwitch, relayField, removingNote, screenFor, startLockRow, termsOutcome, timeLeft, whereIs } from '../connect/screens.js';
import { backAction, settle } from '../connect/nav.js';

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

test('a saved server that cannot be reached offers Retry and Devices', () => {
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

test('an offline computer is named, with what to do', () => {
  assert.equal(screenFor({ screen: 'cezar-offline', serverId: 'r', servers: [paired] }).message,
    'Laptop is asleep or offline. Wake it or check that cezar is running.');
  assert.equal(screenFor({ screen: 'cezar-not-answering', serverId: 'r', servers: [paired] }).message,
    'Laptop is not answering. Wake it or check that cezar is running.');
  assert.equal(screenFor({ screen: 'cezar-offline', serverId: 'r', servers: [{ ...paired, label: '' }] }).message,
    'Your computer is asleep or offline. Wake it or check that cezar is running.');
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

test('the lock row is absent where native has no lock, as on iOS', () => {
  assert.equal(lockRow(undefined), null);
});

test('the lock row turns the lock on or off', () => {
  assert.equal(lockRow({ enabled: false, available: true }).enable, true);
  assert.equal(lockRow({ enabled: true, available: true }).enable, false);
});

test('with no servers the row stays only while the lock is on, so it can still be turned off', () => {
  assert.equal(startLockRow(undefined), null);
  assert.equal(startLockRow({ enabled: false, available: true }), null);
  assert.equal(startLockRow({ enabled: true, available: true }).enable, false);
});

test('with no screen lock the row explains itself and cannot be pressed', () => {
  const off = lockRow({ enabled: false, available: false });
  assert.equal(off.disabled, true);
  assert.match(off.note, /Set a screen lock/);
  assert.match(lockRow({ enabled: true, available: false }).note, /Paused/);
});

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const origin = (source, name) => source.match(new RegExp(`${name} = '?"?(https://[^'"]+)`))?.[1];

test('Enter code starts on the default relay with the field closed', () => {
  const field = relayField('https://relay.example.test');
  assert.equal(field.open, false);
  assert.equal(field.value, 'https://relay.example.test');
});

test('a custom address opens the field and survives a redraw', () => {
  const field = relayField('https://relay.example.test', 'https://mine.example.test');
  assert.equal(field.open, true);
  assert.equal(field.value, 'https://mine.example.test');
});

test('with no address from native the field stays empty, which native reads as its default', () => {
  assert.equal(relayField(undefined).value, '');
});

test('the Android constant matches cezar, and the connect screens repeat neither', () => {
  const android = origin(read('../android/app/src/main/java/com/openmercato/cezar/mobile/shell/relay/RelayOrigin.java'), 'DEFAULT_ORIGIN');
  assert.ok(android);
  assert.equal(android, origin(read('../../cezar/src/relay/wire.ts'), 'DEFAULT_RELAY_ORIGIN'));
  for (const file of ['connect.js', 'screens.js', 'index.html']) assert.ok(!read(`../connect/${file}`).includes(new URL(android).host), file);
});

test('the Notify me switch exists only where native reports push for that cezar, and names it', () => {
  assert.equal(pushSwitch({ id: 'a', url: 'https://x' }), null);
  assert.equal(pushSwitch(null), null);
  const off = pushSwitch({ id: 'r', label: 'Laptop', relay: true, push: false });
  assert.deepEqual([off.label, off.checked, off.enable], ['Notify me', false, true]);
  assert.match(off.note, /When Laptop needs you/);
  assert.deepEqual([pushSwitch({ id: 'r', relay: true, push: true }).checked, pushSwitch({ id: 'r', relay: true, push: true }).enable], [true, false]);
});

test('a forgotten server with a revoke still owed says notifications can still arrive', () => {
  assert.equal(removingNote([]), null);
  assert.equal(removingNote(undefined), null);
  assert.match(removingNote(['Laptop']), /Still removing Laptop\. Notifications from it can arrive/);
  assert.match(removingNote(['A', 'B']), /from them/);
});

test('the Devices link offers Back to the server it came from', () => {
  const servers = [saved, { id: 'b', url: 'https://b.example.com' }];
  assert.equal(backTarget({ screen: 'list', serverId: 'b' }, servers).id, 'b');
});

test('no Back with nothing paired, a forgotten server, or a cold launch on the list', () => {
  assert.equal(backTarget({ screen: 'list', serverId: 'a' }, []), null);
  assert.equal(backTarget({ screen: 'list', serverId: 'gone' }, [saved]), null);
  assert.equal(backTarget({ screen: 'list', serverId: null }, [saved]), null);
  assert.equal(backTarget({ screen: 'connection-error', serverId: 'a' }, [saved]), null);
});

test('the relay account refusals get their own screens, with Back to the list (RELAY_PROTOCOL.md § 18)', () => {
  assert.deepEqual(screenFor({ screen: 'email-unconfirmed', serverId: 'r', servers: [paired] }), { name: 'confirm-email', serverId: 'r', label: 'Laptop', blocked: true });
  assert.deepEqual(screenFor({ screen: 'email-pending', serverId: 'r', servers: [paired] }), { name: 'confirm-email', serverId: 'r', label: 'Laptop', blocked: false });
  assert.deepEqual(screenFor({ screen: 'account-required', serverId: 'r', servers: [paired] }), { name: 'account-required', serverId: 'r', label: 'Laptop' });
  const stack = settle([{ name: 'list' }], screenFor({ screen: 'email-unconfirmed', serverId: 'r', servers: [paired] }), { root: 'list' });
  assert.deepEqual(backAction(stack), { do: 'pop' });
});

test('the confirm screen says why, how long is left and that nothing pairs again', () => {
  assert.equal(confirmLead({ state: 'pending', email: 'me@example.test', secondsLeft: 47 * 3600 + 5 }, false), "Confirm your computer's email within 47 h to keep this phone connected.");
  assert.match(confirmLead({ state: 'blocked', email: 'me@example.test', secondsLeft: 0 }, true), /not confirmed within 48 hours.*do not have to pair again/);
  assert.match(confirmLead(null, true), /not confirmed within 48 hours/);
  for (const line of [confirmLead(null, true), confirmLead(null, false), linkLine(null)]) assert.doesNotMatch(line, /code/i);
  assert.equal(timeLeft(3 * 3600 + 20 * 60), '3 h 20 min');
  assert.equal(timeLeft(30), 'a minute');
  assert.match(ACCOUNT_WHY, /terms and privacy obligations/);
});

test('the confirm screen shows the masked email a phone gets (§ 18)', () => {
  assert.equal(linkLine({ state: 'blocked', email: 'p***@gmail.com', secondsLeft: 0 }), 'We sent a link to p***@gmail.com. Open it to confirm.');
  assert.equal(linkLine(null), "We sent a link to your computer's email. Open it to confirm.");
});

test('a confirmed status opens the server; pending opens it only from the blocked screen', () => {
  assert.equal(accountOpens({ state: 'confirmed' }, false), true);
  assert.equal(accountOpens({ state: 'confirmed' }, true), true);
  assert.equal(accountOpens({ state: 'pending' }, true), true);
  assert.equal(accountOpens({ state: 'pending' }, false), false);
  assert.equal(accountOpens({ state: 'blocked' }, true), false);
  assert.equal(accountOpens(null, true), false);
});

test('suspension and the phone terms get their own screens', () => {
  const paired = { id: 'r', label: 'Laptop', relay: true };
  assert.deepEqual(screenFor({ screen: 'suspended', serverId: 'r', servers: [paired] }), { name: 'suspended', serverId: 'r', label: 'Laptop' });
  assert.deepEqual(screenFor({ screen: 'terms-required-device', serverId: 'r', servers: [paired] }), { name: 'device-terms', serverId: 'r', label: 'Laptop', blocked: true });
  assert.deepEqual(screenFor({ screen: 'device-terms', serverId: 'r', servers: [paired] }), { name: 'device-terms', serverId: 'r', label: 'Laptop', blocked: false });
});

test('a terms answer opens the server, asks again on newer terms, or says why', () => {
  assert.deepEqual(termsOutcome({ device: { termsVersion: 'v', acceptedAt: 1 } }), { open: true });
  assert.deepEqual(termsOutcome({ error: 'x', code: 'no-account' }), { open: true });
  assert.deepEqual(termsOutcome({ error: 'x', code: 'terms-outdated', current: 'v2' }).version, 'v2');
  assert.equal(termsOutcome({ error: 'Offline', code: 'unreachable' }).notice, 'Offline');
});

// Your cezars (spec 2026-11-19-mobile-devices-screen).
const laptop = { id: 'l', label: 'Laptop', relay: true, url: 'https://relay.example.test', status: 'online', words: 'Online', need: 2 };
const vps = { id: 'v', label: 'vps-fra1', url: 'https://cezar.example.com', status: 'offline', words: 'Offline since 09:41', need: 1 };
const box = { id: 'b', label: 'build box', url: 'https://ci.example.com', status: 'other', reason: 'sign-in', words: 'Sign in needed' };

test('a card says where a cezar is without the relay address', () => {
  assert.equal(whereIs(laptop), 'Paired with this phone');
  assert.equal(whereIs(vps), 'cezar.example.com');
  assert.equal(whereIs({ url: 'not a url' }), 'not a url');
});

test('the current cezar is online and owes no count, whatever its probe said', () => {
  const card = cardFor({ ...laptop, status: 'checking', words: 'Checking…' }, 'l');
  assert.deepEqual([card.current, card.status, card.words, card.need], [true, 'online', 'Online', null]);
  assert.equal(card.aria, 'Laptop, Online, current');
  assert.equal(cardFor(laptop, null).need, '2 need you');
  assert.equal(cardFor(laptop, null).aria, 'Laptop, Online, 2 need you');
});

test('a blocked cezar shows its reason in amber and the fix for it', () => {
  const card = cardFor(box, null);
  assert.deepEqual([card.dot, card.fix], ['attention', { label: 'Sign in', action: 'open' }]);
  assert.deepEqual(cardFor({ ...box, reason: 'removed' }, null).fix, { label: 'Pair again', action: 'pair' });
  // Nothing on the phone fixes a suspension or an update: the words say it, no button.
  assert.equal(cardFor({ ...box, reason: 'suspended' }, null).fix, null);
  assert.equal(cardFor({ ...box, reason: 'mystery' }, null).fix, null);
});

test('an older app sends no status, and the card simply has no status line', () => {
  const card = cardFor({ id: 'a', label: 'Work', url: 'https://cezar.example.com' }, null);
  assert.deepEqual([card.status, card.words, card.dot, card.fix], [null, null, null, null]);
});

test('the list orders like the native switcher: current, online, offline, the rest, then by need', () => {
  const quiet = { ...vps, id: 'q', need: 0 };
  assert.deepEqual(orderServers([box, quiet, vps, laptop], null).map((s) => s.id), ['l', 'v', 'q', 'b']);
  assert.deepEqual(orderServers([box, quiet, vps, laptop], 'b').map((s) => s.id), ['b', 'l', 'v', 'q']);
  assert.deepEqual(orderServers([{ id: 'x' }, { id: 'y' }], null).map((s) => s.id), ['x', 'y']);
});

test('the primary button does the one thing that helps', () => {
  assert.deepEqual(primaryFor(cardFor(laptop, 'l')), { label: 'Back to Laptop', action: 'open' });
  assert.deepEqual(primaryFor(cardFor(laptop, null)), { label: 'Open Manager', action: 'open' });
  assert.deepEqual(primaryFor(cardFor(vps, null)), { label: 'Try again', action: 'open' });
  assert.deepEqual(primaryFor(cardFor({ ...box, reason: 'removed' }, null)), { label: 'Pair again', action: 'pair' });
});

test('counts, needs and names read as sentences', () => {
  assert.equal(countLine(1), 'The cezar this phone is connected to.');
  assert.equal(countLine(3), '3 cezars connected to this phone.');
  assert.equal(needWords(1), '1 needs you');
  assert.equal(needWords(0), null);
  assert.equal(needWords(null), null);
});

test('a new name is trimmed, and refused when empty or too long', () => {
  assert.deepEqual(checkName('  Studio  '), { name: 'Studio' });
  assert.match(checkName('   ').error, /Enter a name/);
  assert.match(checkName(null).error, /Enter a name/);
  assert.match(checkName('x'.repeat(MAX_NAME + 1)).error, /at most 60/);
  assert.deepEqual(checkName('x'.repeat(MAX_NAME)), { name: 'x'.repeat(MAX_NAME) });
});

test('the App section reports the phone-wide notification permission only when native knows it', () => {
  assert.equal(notificationsRow('allowed').value, 'On');
  assert.equal(notificationsRow('denied').value, 'Off');
  assert.equal(notificationsRow('unknown'), null);
  assert.equal(notificationsRow(undefined), null);
});

test('the app lock is one switch that says what it does', () => {
  assert.deepEqual([lockRow({ enabled: true, available: true }).label, lockRow({ enabled: true, available: true }).checked], ['App lock', true]);
  assert.equal(lockRow({ enabled: true, available: false }).checked, true);
});

test('Forget says what goes, for a paired cezar and a direct one', () => {
  assert.match(forgetLead(laptop), /removed from Laptop.*pair with a new code/);
  assert.match(forgetLead(vps), /saved password/);
});
