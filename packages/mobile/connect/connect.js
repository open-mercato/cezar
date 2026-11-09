// The bundled connect screen. It talks to native through the Connection plugin and nothing else;
// server pages run in a separate webview with no bridge (spec Decision 2).
import { lockRow, pushSwitch, relayField, removingNote, screenFor, startLockRow } from './screens.js';

const app = document.getElementById('app');
let servers = [];
let removing = [];
let context = {};
// Android only for now. iOS keeps the URL form until its client compiles.
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

async function run(method, options, nextContext) {
  context = nextContext ?? context;
  draw(loading('Connecting…'));
  try {
    show(await call(method, options));
  } catch (error) {
    draw(notice(String(error?.message ?? error)), button('Servers', () => drawList()));
  }
}

async function poll(seq) {
  try {
    show(await call('pairPoll', { seq }));
  } catch (error) {
    draw(notice(String(error?.message ?? error)), button('Servers', () => drawList()));
  }
}

function show(outcome) {
  servers = outcome.servers ?? servers;
  removing = outcome.removing ?? removing;
  pairing = outcome.pairing ?? pairing;
  lock = outcome.lock ?? lock;
  relayDefault = outcome.relayDefault ?? relayDefault;
  const screen = screenFor(outcome, context);
  if (screen.name === 'pair-waiting') drawPairWaiting(screen);
  else if (screen.name === 'pair-confirm') drawPairConfirm(screen);
  else if (screen.name === 'pair-failed') drawPairFailed(screen);
  else if (screen.name === 'removed') drawRemoved(screen);
  else if (screen.name === 'start') drawStart();
  else if (screen.name === 'busy') draw(loading('Opening…'));
  else if (screen.name === 'credentials') drawCredentials(screen);
  else if (screen.name === 'error') drawError(screen);
  else if (screen.name === 'add') drawAdd(screen);
  else drawList();
}

function lockSection(row, text) {
  if (!row) return null;
  const toggle = button(row.label, async () => {
    toggle.disabled = true;
    lockChanging = true;
    try {
      const outcome = await call('lockSet', { enabled: row.enable });
      show(outcome);
      if (outcome.lockError) drawList(outcome.lockError);
    } catch (error) {
      drawList(String(error?.message ?? error));
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
      if (outcome.pushError) drawList(outcome.pushError);
    } catch (error) {
      drawList(String(error?.message ?? error));
    }
  };
  return element('label', { className: 'switch' }, input, element('span', { textContent: row.label }));
}

function drawList(lockNotice) {
  if (!servers.length) return pairing ? drawStart(lockNotice) : drawAdd({});
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
      button('Forget', () => drawForget(server)),
      notificationsSwitch(server),
    ),
  );
  const leaving = removingNote(removing);
  draw(element('h1', { textContent: 'Servers' }), element('ul', {}, ...rows), leaving && element('p', { className: 'muted', textContent: leaving }), button('Add server', () => (pairing ? drawStart() : drawAdd({})), 'primary'), lockSection(lockRow(lock), lockNotice));
  lockScreen = drawList;
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

function drawForget(server) {
  draw(
    element('h1', { textContent: `Forget ${server.label}?` }),
    element('p', { textContent: server.relay ? 'This removes this phone from that computer and deletes its keys and website data.' : 'This deletes its saved password and website data from this phone.' }),
    element(
      'div',
      { className: 'actions' },
      button('Cancel', () => drawList()),
      button('Forget server', () => run('forget', { id: server.id }, {}), 'primary'),
    ),
  );
}

function drawStart(lockNotice) {
  const advanced = element('details', {}, element('summary', { textContent: 'Advanced' }), addForm({}));
  draw(
    element('h1', { textContent: 'Connect to cezar' }),
    element('p', { className: 'muted', textContent: 'On your computer, open Settings, then Connect a phone.' }),
    element('div', { className: 'stack' }, button('Scan QR code', () => run('scan', {}, {}), 'primary'), button('Enter code', () => drawCode({}))),
    advanced,
    lockSection(startLockRow(lock), lockNotice),
  );
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
    element('div', { className: 'actions' }, button('Back', () => drawList()), element('button', { className: 'primary', textContent: 'Connect' })),
  );
  form.onsubmit = (event) => {
    event.preventDefault();
    const data = new FormData(form);
    run('pairCode', { code: data.get('code'), relay: data.get('relay') }, {});
  };
  draw(element('h1', { textContent: 'Enter code' }), form);
}

const cancelPairing = () => run('pairCancel', {}, {});

function drawPairWaiting({ seq }) {
  if (!pairWaiting) draw(loading('Connecting to your computer…'), button('Cancel', cancelPairing, 'cancel'));
  pairWaiting = true;
  poll(seq);
}

function drawPairConfirm({ digits, label, seq }) {
  draw(
    element('h1', { textContent: 'Confirm on your computer' }),
    element('p', { textContent: `Approve this phone on ${label} if it shows the same number.` }),
    element('p', { className: 'digits', textContent: digits }),
    button('Cancel', cancelPairing),
  );
  poll(seq);
}

function drawPairFailed({ message }) {
  draw(element('h1', { textContent: 'Not paired' }), notice(message), element('div', { className: 'actions' }, button('Back', () => (servers.length ? drawList() : drawStart())), button('Try again', () => drawStart(), 'primary')));
}

function drawRemoved({ serverId, label }) {
  draw(
    element('h1', { textContent: 'This phone was removed from cezar.' }),
    element(
      'div',
      { className: 'stack' },
      button('Try again', () => run('open', { id: serverId }, { serverId }), 'primary'),
      button('Pair again', () => drawStart()),
      button('Forget', () => drawForget({ id: serverId, label, relay: true })),
    ),
  );
}

function drawAdd({ url, notice: text }) {
  draw(element('h1', { textContent: 'Connect to cezar' }), addForm({ url, notice: text }));
}

function addForm({ url, notice: text }) {
  const form = element(
    'form',
    {},
    notice(text),
    field('Server address', 'url', { type: 'url', inputMode: 'url', placeholder: 'https://cezar.example.com', value: url ?? '', required: true }),
    element('div', { className: 'actions' }, servers.length ? button('Back', () => drawList()) : null, element('button', { className: 'primary', textContent: 'Connect' })),
  );
  form.onsubmit = (event) => {
    event.preventDefault();
    const value = new FormData(form).get('url');
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
    element('div', { className: 'actions' }, button('Back', () => drawList()), element('button', { className: 'primary', textContent: 'Sign in' })),
  );
  form.onsubmit = (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const entered = data.get('username');
    run('add', { url, username: entered, password: data.get('password') }, { url, username: entered });
  };
  draw(element('h1', { textContent: 'Sign in' }), form);
}

function drawError({ serverId, message }) {
  draw(
    element('h1', { textContent: 'Connection problem' }),
    notice(message),
    element('div', { className: 'actions' }, button('Servers', () => drawList()), button('Retry', () => run('open', { id: serverId }, { serverId }), 'primary')),
  );
}

document.addEventListener('visibilitychange', refreshLock);
run('launch');
