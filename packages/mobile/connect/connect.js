// The bundled connect screen. It talks to native through the Connection plugin and nothing else;
// server pages run in a separate webview with no bridge (spec Decision 2).
import { screenFor } from './screens.js';

const app = document.getElementById('app');
let servers = [];
let context = {};
// Android only for now. iOS keeps the URL form until its client compiles.
let pairing = false;

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

const notice = (text) => (text ? element('p', { className: 'notice', textContent: text }) : null);

function draw(...nodes) {
  app.replaceChildren(...nodes.filter(Boolean));
}

async function run(method, options, nextContext) {
  context = nextContext ?? context;
  draw(element('p', { className: 'muted', textContent: 'Connecting…' }));
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
  pairing = outcome.pairing ?? pairing;
  const screen = screenFor(outcome, context);
  if (screen.name === 'pair-waiting') drawPairWaiting(screen);
  else if (screen.name === 'pair-confirm') drawPairConfirm(screen);
  else if (screen.name === 'pair-failed') drawPairFailed(screen);
  else if (screen.name === 'removed') drawRemoved(screen);
  else if (screen.name === 'start') drawStart();
  else if (screen.name === 'busy') draw(element('p', { className: 'muted', textContent: 'Opening…' }));
  else if (screen.name === 'credentials') drawCredentials(screen);
  else if (screen.name === 'error') drawError(screen);
  else if (screen.name === 'add') drawAdd(screen);
  else drawList();
}

function drawList() {
  if (!servers.length) return pairing ? drawStart() : drawAdd({});
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
    ),
  );
  draw(element('h1', { textContent: 'Servers' }), element('ul', {}, ...rows), button('Add server', () => (pairing ? drawStart() : drawAdd({})), 'primary'));
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

function drawStart() {
  const advanced = element('details', {}, element('summary', { textContent: 'Advanced' }), addForm({}));
  draw(
    element('h1', { textContent: 'Connect to cezar' }),
    element('p', { className: 'muted', textContent: 'On your computer, open Settings, then Connect a phone.' }),
    element('div', { className: 'stack' }, button('Scan QR code', () => run('scan', {}, {}), 'primary'), button('Enter code', () => drawCode({}))),
    advanced,
  );
}

function drawCode({ code, relay, notice: text }) {
  const form = element(
    'form',
    {},
    notice(text),
    field('Code', 'code', { value: code ?? '', placeholder: 'XXXX-XXXX-XXXX', required: true, autocapitalize: 'characters' }),
    field('Relay address', 'relay', { type: 'url', inputMode: 'url', value: relay ?? '', placeholder: 'https://relay.example.com', required: true }),
    element('p', { className: 'muted', textContent: 'Your computer shows the address beside the code. A QR code is safer if you can use one.' }),
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
  draw(element('p', { className: 'muted', textContent: 'Connecting to your computer…' }), button('Cancel', cancelPairing));
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

run('launch');
