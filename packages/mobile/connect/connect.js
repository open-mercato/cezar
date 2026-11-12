// The bundled connect screen. It talks to native through the Connection plugin and nothing else;
// server pages run in a separate webview with no bridge (spec Decision 2).
import { backAction, dropPairing, hasArrow, rootScreen, settle } from './nav.js';
import { backTarget, lockRow, pushSwitch, relayField, removingNote, screenFor, startLockRow } from './screens.js';

const app = document.getElementById('app');
let servers = [];
let removing = [];
let context = {};
// The server the cockpit's Servers link came from: the list's Back returns there.
let cameFrom = null;
// The navigation stack (nav.js); its top is the screen drawn now, unless a request is in flight.
let stack = [];
// Bumped when Back abandons a request or a pairing, so its late answer is dropped.
let token = 0;
let inflight = null;
// "Stop pairing?" is up over the six digits.
let confirming = false;
// Native reports it: true once the app has a relay client.
let pairing = false;
let lock = null;
let relayDefault;
let lockScreen = null;
let lockChanging = false;
// Each poll answer redraws its screen; the waiting one stays put so its mark does not restart.
let pairWaiting = false;

const call = (method, options = {}) => window.Capacitor.nativePromise('Connection', method, options);

function element(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
}

const button = (text, onclick, className = '') => element('button', { type: 'button', textContent: text, onclick, className });

function field(label, name, props = {}) {
  return element('label', { textContent: label }, element('input', { name, autocapitalize: 'none', autocomplete: 'off', spellcheck: false, ...props }));
}

const SVG = 'http://www.w3.org/2000/svg';
// docs/brand/cezar-mark-*.svg, built as DOM so the CSP needs no img-src.
const MARK = ['354.6,217.3 511.0,307.6 421.0,359.6 354.6,321.2 267.9,371.2 267.9,471.3 444.6,573.3 354.6,625.3 177.9,523.3 177.9,319.3', '177.9,284.6 354.6,182.6 354.6,78.7 177.9,180.7', '354.6,372.3 397.0,396.8 397.0,445.8 354.6,470.3 312.1,445.8 312.1,396.8', '483.7,372.3 526.1,396.8 526.1,445.8 483.7,470.3 441.2,445.8 441.2,396.8'];

function svg(tag, attributes, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

// A full-screen wait: the mark breathing above what is happening. connect.css holds it back for a beat, so a fast answer never flashes it.
function loading(text) {
  const mark = svg('svg', { class: 'mark', viewBox: '177.9 78.7 348.2 546.6', 'aria-hidden': 'true' }, ...MARK.map((points) => svg('polygon', { points })));
  const wait = element('div', { className: 'loading' }, mark, element('p', { className: 'muted', textContent: text }));
  wait.setAttribute('role', 'status');
  wait.setAttribute('aria-busy', 'true');
  return wait;
}

const notice = (text) => (text ? element('p', { className: 'notice', textContent: text }) : null);

function draw(...nodes) {
  lockScreen = null;
  pairWaiting = false;
  app.replaceChildren(...nodes.filter(Boolean));
}

const lastServer = () => servers.find((server) => server.id === cameFrom) ?? null;
const env = () => ({ last: lastServer()?.id, confirming });

// Top-left arrow beside the screen's title; the root shows none unless the list has a server to return to.
function titled(text) {
  const title = text ? element('h1', { textContent: text }) : null;
  if (!hasArrow(stack, env())) return title;
  const arrow = button('←', () => goBack(), 'back');
  const target = stack.length === 1 ? lastServer() : null;
  arrow.setAttribute('aria-label', target ? `Back to ${target.label}` : 'Back');
  return element('div', { className: 'title' }, arrow, title);
}

/** One level back. False only at a root with nowhere to go, so Android's Back leaves the app. */
function goBack() {
  if (inflight) {
    if (!stack.length) return false;
    // A request still running is abandoned; a pairing it started is stopped.
    const pairingStarted = inflight === 'pairCode' || inflight === 'scan';
    token += 1;
    inflight = null;
    if (pairingStarted) call('pairCancel').catch(() => {});
    render();
    return true;
  }
  const action = backAction(stack, env());
  if (action.do === 'exit') return false;
  if (action.do === 'open') run('open', { id: action.id, quick: true }, { serverId: action.id });
  else if (action.do === 'cancel-pairing') cancelPairing();
  else if (action.do === 'confirm-cancel') {
    confirming = true;
    render();
  } else if (action.do === 'keep-pairing') {
    confirming = false;
    render();
  } else {
    stack = stack.slice(0, -1);
    render();
  }
  return true;
}

function go(entry) {
  stack = [...stack, entry];
  render();
}

// Remembers what a form held, so popping back to it shows the input again.
function keep(props) {
  if (stack.length) stack = [...stack.slice(0, -1), { ...stack.at(-1), ...props }];
}

function render(lockNotice) {
  const top = stack.at(-1) ?? { name: rootScreen({ servers, pairing }) };
  if (top.name !== 'pair-confirm') confirming = false;
  if (top.name === 'pair-waiting') drawPairWaiting(top);
  else if (top.name === 'pair-confirm') drawPairConfirm(top);
  else if (top.name === 'pair-failed') drawPairFailed(top);
  else if (top.name === 'removed') drawRemoved(top);
  else if (top.name === 'start') drawStart(top, lockNotice);
  else if (top.name === 'credentials') drawCredentials(top);
  else if (top.name === 'error') drawError(top);
  else if (top.name === 'forget') drawForget(top);
  else if (top.name === 'code') drawCode(top);
  else if (top.name === 'add') drawAdd(top);
  else drawList(lockNotice);
}

/** `how` is nav.js settle's: launch and Forget rebuild from the root, a cancel drops the pairing, the rest stay. */
async function run(method, options, nextContext, how = 'stay') {
  context = nextContext ?? context;
  const mine = ++token;
  inflight = method;
  draw(titled(), loading('Connecting…'));
  try {
    const outcome = await call(method, options);
    if (mine !== token) return;
    inflight = null;
    show(outcome, how, method);
  } catch (error) {
    if (mine !== token) return;
    inflight = null;
    failed(error);
  }
}

function failed(error) {
  stack = settle(stack, { name: 'error', message: String(error?.message ?? error) }, { root: rootScreen({ servers, pairing }) });
  render();
}

async function poll(seq) {
  const mine = token;
  try {
    const outcome = await call('pairPoll', { seq });
    if (mine === token) show(outcome);
  } catch (error) {
    if (mine === token) failed(error);
  }
}

function show(outcome, how = 'stay', method) {
  servers = outcome.servers ?? servers;
  if (method === 'launch' && outcome.screen === 'list') cameFrom = backTarget(outcome, servers)?.id ?? null;
  removing = outcome.removing ?? removing;
  pairing = outcome.pairing ?? pairing;
  lock = outcome.lock ?? lock;
  relayDefault = outcome.relayDefault ?? relayDefault;
  const screen = screenFor(outcome, context);
  if (screen.name === 'busy') return draw(loading('Opening…'));
  const wasConfirm = stack.at(-1)?.name === 'pair-confirm';
  stack = settle(stack, screen, { how: method === 'launch' ? 'reset' : how, root: rootScreen({ servers, pairing }) });
  // A poll answer with the same digits keeps "Stop pairing?" up.
  if (!(wasConfirm && screen.name === 'pair-confirm')) confirming = false;
  render();
  // Each phase answers one long poll; Back bumps the token and drops it.
  if (screen.name === 'pair-waiting' || screen.name === 'pair-confirm') poll(screen.seq);
}

function lockSection(row, text) {
  if (!row) return null;
  const toggle = button(row.label, async () => {
    toggle.disabled = true;
    lockChanging = true;
    try {
      const outcome = await call('lockSet', { enabled: row.enable });
      show(outcome);
      if (outcome.lockError) render(outcome.lockError);
    } catch (error) {
      render(String(error?.message ?? error));
    } finally {
      lockChanging = false;
    }
  });
  toggle.disabled = Boolean(row.disabled);
  return element('section', { className: 'stack' }, notice(text), toggle, element('p', { className: 'muted', textContent: row.note }));
}

// A switch per relay server. Turning it on may raise Android's permission prompt; the answer redraws the list.
function notificationsSwitch(server) {
  const row = pushSwitch(server);
  if (!row) return null;
  const input = element('input', { type: 'checkbox', checked: row.checked });
  input.setAttribute('role', 'switch');
  input.onchange = async () => {
    input.disabled = true;
    try {
      const outcome = await call('pushSet', { id: server.id, enabled: row.enable });
      show(outcome);
      if (outcome.pushError) render(outcome.pushError);
    } catch (error) {
      render(String(error?.message ?? error));
    }
  };
  return element('label', { className: 'switch' }, input, element('span', { textContent: row.label }));
}

function drawList(lockNotice) {
  if (!servers.length) return pairing ? drawStart({}, lockNotice) : drawAdd({});
  const rows = servers.map((server) =>
    element(
      'li',
      {},
      element(
        'button',
        { type: 'button', className: 'open', onclick: () => run('open', { id: server.id }, { serverId: server.id }) },
        element('span', { textContent: server.label }),
        element('span', { className: 'muted', textContent: server.url }),
      ),
      button('Forget', () => go({ name: 'forget', server })),
      notificationsSwitch(server),
    ),
  );
  const leaving = removingNote(removing);
  draw(titled('Servers'), element('ul', {}, ...rows), leaving && element('p', { className: 'muted', textContent: leaving }), button('Add server', () => go({ name: pairing ? 'start' : 'add' }), 'primary'), lockSection(lockRow(lock), lockNotice));
  lockScreen = render;
}

// The phone's screen lock can change in Settings with this page alive. Only the row redraws, so no form loses its input.
async function refreshLock() {
  if (!lock || lockChanging || document.visibilityState !== 'visible') return;
  const outcome = await call('list').catch(() => null);
  if (!outcome?.lock || lockChanging || !lockScreen) return;
  const changed = outcome.lock.enabled !== lock.enabled || outcome.lock.available !== lock.available;
  lock = outcome.lock;
  if (changed) lockScreen();
}

function drawForget({ server }) {
  draw(
    titled(`Forget ${server.label}?`),
    element('p', { textContent: server.relay ? 'This removes this phone from that computer and deletes its keys and website data.' : 'This deletes its saved password and website data from this phone.' }),
    element(
      'div',
      { className: 'actions' },
      button('Cancel', () => goBack()),
      // `from`: Android restarts the app to drop the webview's auth cache, and the list's Back must survive that.
      button('Forget server', () => run('forget', { id: server.id, from: cameFrom === server.id ? null : cameFrom }, {}, 'reset'), 'primary'),
    ),
  );
}

// Advanced unfolds in place and is no level of its own: Back leaves the screen, folded or not.
function drawStart({ advanced, url }, lockNotice) {
  const details = element('details', { open: Boolean(advanced) }, element('summary', { textContent: 'Advanced' }), addForm({ url }));
  details.ontoggle = () => keep({ advanced: details.open });
  draw(
    titled('Connect to cezar'),
    element('p', { className: 'muted', textContent: 'On your computer, open Settings, then Connect a phone.' }),
    element('div', { className: 'stack' }, button('Scan QR code', () => run('scan', {}, {}), 'primary'), button('Enter code', () => go({ name: 'code' }))),
    details,
    lockSection(startLockRow(lock), lockNotice),
  );
  lockScreen = render;
}

function drawCode({ code, relay, notice: text }) {
  const address = relayField(relayDefault, relay);
  const form = element(
    'form',
    {},
    notice(text),
    field('Code', 'code', { value: code ?? '', placeholder: 'XXXX-XXXX-XXXX', required: true, autocapitalize: 'characters' }),
    element('p', { className: 'muted', textContent: 'A QR code is safer if you can use one.' }),
    element(
      'details',
      { open: address.open },
      element('summary', { textContent: 'Advanced' }),
      field('Relay address', 'relay', { inputMode: 'url', value: address.value, placeholder: address.placeholder }),
      element('p', { className: 'muted', textContent: address.note }),
    ),
    element('div', { className: 'actions' }, element('button', { className: 'primary', textContent: 'Connect' })),
  );
  form.onsubmit = (event) => {
    event.preventDefault();
    const data = new FormData(form);
    // Advanced reopens on return only for an address the user changed.
    const relay = data.get('relay');
    keep({ code: data.get('code'), relay: relay && relay !== relayDefault ? relay : undefined });
    run('pairCode', { code: data.get('code'), relay: data.get('relay') }, {});
  };
  draw(titled('Enter code'), form);
}

// Stops the pairing on both ends and returns to the screen that started it.
function cancelPairing() {
  token += 1;
  confirming = false;
  run('pairCancel', {}, {}, 'cancel');
}

function drawPairWaiting() {
  if (!pairWaiting) draw(titled(), loading('Connecting to your computer…'), button('Cancel', () => goBack(), 'cancel'));
  pairWaiting = true;
}

function drawPairConfirm({ digits, label }) {
  const ask = confirming
    ? element(
        'section',
        { className: 'stack' },
        notice('Stop pairing? To pair later, show a new code on your computer.'),
        element('div', { className: 'actions' }, button('Keep pairing', () => goBack()), button('Stop pairing', cancelPairing, 'primary')),
      )
    : button('Cancel', () => goBack());
  draw(titled('Confirm on your computer'), element('p', { textContent: `Approve this phone on ${label} if it shows the same number.` }), element('p', { className: 'digits', textContent: digits }), ask);
}

function tryAgain() {
  stack = dropPairing(stack);
  render();
}

function drawPairFailed({ message }) {
  draw(titled('Not paired'), notice(message), element('div', { className: 'actions' }, button('Try again', tryAgain, 'primary')));
}

function drawRemoved({ serverId, label }) {
  draw(
    titled('This phone was removed from cezar.'),
    element(
      'div',
      { className: 'stack' },
      button('Try again', () => run('open', { id: serverId }, { serverId }), 'primary'),
      button('Pair again', () => go({ name: 'start' })),
      button('Forget', () => go({ name: 'forget', server: { id: serverId, label, relay: true } })),
    ),
  );
}

function drawAdd({ url, notice: text }) {
  draw(titled('Connect to cezar'), addForm({ url, notice: text }));
}

function addForm({ url, notice: text }) {
  const form = element(
    'form',
    {},
    notice(text),
    field('Server address', 'url', { type: 'url', inputMode: 'url', placeholder: 'https://cezar.example.com', value: url ?? '', required: true }),
    element('div', { className: 'actions' }, element('button', { className: 'primary', textContent: 'Connect' })),
  );
  form.onsubmit = (event) => {
    event.preventDefault();
    const value = new FormData(form).get('url');
    keep({ url: value });
    run('add', { url: value }, { url: value });
  };
  return form;
}

function drawCredentials({ url, username, notice: text }) {
  const form = element(
    'form',
    {},
    notice(text),
    element('p', { className: 'muted', textContent: url }),
    field('Username', 'username', { value: username, required: true, autocomplete: 'username' }),
    field('Password', 'password', { type: 'password', required: true, autocomplete: 'current-password' }),
    element('div', { className: 'actions' }, element('button', { className: 'primary', textContent: 'Sign in' })),
  );
  form.onsubmit = (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const entered = data.get('username');
    run('add', { url, username: entered, password: data.get('password') }, { url, username: entered });
  };
  draw(titled('Sign in'), form);
}

function drawError({ serverId, message }) {
  draw(titled('Connection problem'), notice(message), serverId ? element('div', { className: 'actions' }, button('Retry', () => run('open', { id: serverId }, { serverId }), 'primary')) : null);
}

document.addEventListener('visibilitychange', refreshLock);
// Native asks before its own Back: true means the page took it, false lets Android leave the app (MainActivity, ShellViewController).
window.cezarBack = () => goBack();

run('launch');
