// The bundled connect screen. It talks to native through the Connection plugin and nothing else;
// server pages run in a separate webview with no bridge (spec Decision 2).
import { backTarget, screenFor } from './screens.js';

const app = document.getElementById('app');
let servers = [];
let context = {};
// The server the cockpit's Servers link came from: the list's Back returns there.
let cameFrom = null;
// What Back does on the screen drawn now: the arrow, Android's Back and iOS's edge swipe all call it.
let back = null;

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
  back = null;
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

function show(outcome) {
  servers = outcome.servers ?? servers;
  if (outcome.screen === 'list') cameFrom = backTarget(outcome, servers)?.id ?? null;
  const screen = screenFor(outcome, context);
  if (screen.name === 'busy') draw(element('p', { className: 'muted', textContent: 'Opening…' }));
  else if (screen.name === 'credentials') drawCredentials(screen);
  else if (screen.name === 'error') drawError(screen);
  else if (screen.name === 'add') drawAdd(screen);
  else drawList();
}

function drawList() {
  if (!servers.length) return drawAdd({});
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
  const target = servers.find((server) => server.id === cameFrom);
  const title = element('h1', { textContent: 'Servers' });
  draw(target ? element('div', { className: 'title' }, backArrow(target), title) : title, element('ul', {}, ...rows), button('Add server', () => drawAdd({}), 'primary'));
  if (target) back = () => run('open', { id: target.id }, { serverId: target.id });
}

function backArrow(target) {
  const arrow = button('←', () => back?.(), 'back');
  arrow.setAttribute('aria-label', `Back to ${target.label}`);
  return arrow;
}

function drawForget(server) {
  draw(
    element('h1', { textContent: `Forget ${server.label}?` }),
    element('p', { textContent: 'This deletes its saved password and website data from this phone.' }),
    element(
      'div',
      { className: 'actions' },
      button('Cancel', () => drawList()),
      button('Forget server', () => run('forget', { id: server.id }, {}), 'primary'),
    ),
  );
  back = drawList;
}

function drawAdd({ url, notice: text }) {
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
  draw(element('h1', { textContent: 'Connect to cezar' }), form);
  if (servers.length) back = drawList;
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
  back = drawList;
}

function drawError({ serverId, message }) {
  draw(
    element('h1', { textContent: 'Connection problem' }),
    notice(message),
    element('div', { className: 'actions' }, button('Servers', () => drawList()), button('Retry', () => run('open', { id: serverId }, { serverId }), 'primary')),
  );
  back = drawList;
}

// Native asks before its own Back: true means the page took it (MainActivity, ShellViewController).
window.cezarBack = () => {
  if (!back) return false;
  back();
  return true;
};

run('launch');
