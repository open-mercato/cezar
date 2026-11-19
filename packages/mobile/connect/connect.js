// The bundled connect screen. It talks to native through the Connection plugin and nothing else;
// server pages run in a separate webview with no bridge (spec Decision 2).
import { backAction, dropPairing, hasArrow, rootScreen, settle } from './nav.js';
import { ACCOUNT_WHY, MAX_NAME, RELAY_TERMS, accountOpens, backTarget, cardFor, checkName, confirmLead, countLine, forgetLead, linkLine, lockRow, notificationsRow, orderServers, primaryFor, pushSwitch, relayField, removingNote, screenFor, startLockRow, termsLead, termsOutcome } from './screens.js';

const app = document.getElementById('app');
let servers = [];
let removing = [];
let context = {};
// The cezar the cockpit's Devices link came from: the list's Back returns there, and its card is the current one.
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
// Native reports them (spec 2026-11-19-mobile-devices-screen); an older app sends neither.
let notifications = null;
let version = null;
// The cezar whose name is being edited, and why the last try was refused.
let renaming = null;
let renameNotice = null;
// Wide windows (an iPad) show the list and one cezar's page side by side.
let selected = null;
const wideQuery = window.matchMedia?.('(min-width: 900px)');
const wide = () => Boolean(wideQuery?.matches);

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

/** Taken before an await: true while the same screen is still on top, so a late answer acts on nothing else. */
function stillHere() {
  const depth = stack.length;
  const { name, serverId } = stack.at(-1) ?? {};
  return () => !inflight && stack.length === depth && stack.at(-1)?.name === name && stack.at(-1)?.serverId === serverId;
}

function render(lockNotice) {
  const top = stack.at(-1) ?? { name: rootScreen({ servers, pairing }) };
  if (top.name !== 'pair-confirm') confirming = false;
  if (top.name === 'pair-waiting') drawPairWaiting(top);
  else if (top.name === 'pair-confirm') drawPairConfirm(top);
  else if (top.name === 'pair-failed') drawPairFailed(top);
  else if (top.name === 'removed') drawRemoved(top);
  else if (top.name === 'confirm-email') drawConfirmEmail(top);
  else if (top.name === 'account-required') drawAccountRequired(top);
  else if (top.name === 'device-terms') drawDeviceTerms(top);
  else if (top.name === 'suspended') drawSuspended(top);
  else if (top.name === 'start') drawStart(top, lockNotice);
  else if (top.name === 'credentials') drawCredentials(top);
  else if (top.name === 'error') drawError(top);
  else if (top.name === 'forget') drawForget(top, lockNotice);
  else if (top.name === 'cezar') drawCezar(top, lockNotice);
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
  // The reminder's Confirm came from a working server page: the list's Back returns there.
  if (method === 'launch' && outcome.screen === 'email-pending') cameFrom = outcome.serverId ?? null;
  removing = outcome.removing ?? removing;
  pairing = outcome.pairing ?? pairing;
  lock = outcome.lock ?? lock;
  relayDefault = outcome.relayDefault ?? relayDefault;
  notifications = outcome.notifications ?? notifications;
  version = outcome.version ?? version;
  // The switcher's Add a device: the form one level above the list, so Back lands on the devices.
  if (method === 'launch' && outcome.screen === 'add' && servers.length) {
    cameFrom = servers.some((row) => row.id === outcome.serverId) ? outcome.serverId : null;
    stack = [{ name: 'list' }, { name: pairing ? 'start' : 'add' }];
    return render();
  }
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

// A row of a grouped list: its label is the node's own text, so the whole row is one target and one name.
function item(tag, label, props = {}, ...children) {
  return element(tag, { textContent: label, ...props, className: `item ${props.className ?? ''}`.trim() }, ...children);
}

const small = (text) => (text ? element('small', { textContent: text }) : null);
const group = (...rows) => element('div', { className: 'group' }, ...rows.filter(Boolean));
const eyebrow = (text) => element('h2', { className: 'eyebrow', textContent: text });

function switchInput(label, checked, onchange) {
  const input = element('input', { type: 'checkbox', checked: Boolean(checked) });
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-label', label);
  input.onchange = async () => {
    input.disabled = true;
    await onchange();
  };
  return input;
}

function lockItem(row) {
  if (!row) return null;
  const input = switchInput(row.label, row.checked, async () => {
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
  input.disabled = Boolean(row.disabled);
  return item('label', row.label, { className: 'toggle' }, small(row.note), input);
}

// The phone-wide part of the list, apart from any one cezar.
function appSection(lockRowNow, { full = true } = {}) {
  const permission = full ? notificationsRow(notifications) : null;
  const note = element('p', { className: 'muted log-note' });
  const copy = item('button', 'Copy startup log', { type: 'button' }, small('For a bug report.'));
  copy.onclick = async () => {
    try {
      const outcome = await call('startupLogCopy');
      note.textContent = outcome?.copied ? `Copied ${outcome.lines} lines.` : 'Could not reach the clipboard.';
    } catch {
      note.textContent = 'This version of the app keeps no startup log.';
    }
  };
  const settings = permission && item('button', 'Notifications', { type: 'button', onclick: () => call('notificationSettings').catch(() => {}) }, small(permission.note), element('span', { className: 'value', textContent: permission.value }));
  const policy = item('a', 'Privacy policy', { href: 'https://openmercatocloud.com/privacy', target: '_blank', rel: 'noreferrer' });
  const shown = version && item('div', 'Version', {}, element('span', { className: 'value', textContent: version }));
  return element('section', { className: 'app-section' }, eyebrow('App'), group(lockItem(lockRowNow), settings, copy, policy, shown), note);
}

function avatar(server, view, size = '') {
  const node = element('span', { className: `avatar ${size}`.trim(), textContent: server.initials ?? '' }, view.dot ? element('span', { className: `dot ${view.dot}` }) : null);
  // CSSOM, which the page's CSP allows where a style attribute would not be.
  if (server.color) node.style.background = server.color;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

const pill = (view) => (view.current ? element('span', { className: 'pill', textContent: 'Current' }) : null);

function statusLine(view, need = view.need) {
  if (!view.words) return null;
  return element('span', { className: `state ${view.dot}` }, element('span', { textContent: view.words }), need ? element('span', { className: 'need', textContent: ` · ${need}` }) : null);
}

function openCezar(server) {
  run('open', server.id === cameFrom ? { id: server.id, quick: true } : { id: server.id }, { serverId: server.id });
}

function act(action, server) {
  if (action === 'pair') go({ name: pairing ? 'start' : 'add' });
  else openCezar(server);
}

function showCezar(id) {
  renaming = null;
  renameNotice = null;
  if (wide()) {
    selected = id;
    render();
  } else go({ name: 'cezar', serverId: id });
}

const selectedId = (ordered) => (ordered.some((row) => row.id === selected) ? selected : ordered[0]?.id);

function card(server, { chosen } = {}) {
  const view = cardFor(server, cameFrom);
  const open = element(
    'button',
    { type: 'button', className: 'open', onclick: () => openCezar(server) },
    avatar(server, view),
    element('span', { className: 'who' }, element('span', { className: 'name' }, element('span', { className: 'label', textContent: view.label }), pill(view)), element('span', { className: 'where', textContent: view.where }), statusLine(view)),
    view.fix ? null : element('span', { className: 'chevron', textContent: '›' }),
  );
  open.setAttribute('aria-label', `${view.aria}. Opens it.`);
  const fix = view.fix ? button(view.fix.label, () => act(view.fix.action, server), 'fix') : null;
  const more = button('⋯', () => showCezar(server.id), 'more');
  more.setAttribute('aria-label', `Settings for ${view.label}`);
  return element('li', { className: ['card', view.current && 'current', chosen && 'selected'].filter(Boolean).join(' ') }, open, fix, more);
}

// One cezar: its card, why it cannot open, and the one button that does the main job.
function hero(server) {
  const view = cardFor(server, cameFrom);
  const primary = primaryFor(view);
  const hint = view.status === 'offline'
    ? `${view.label} is asleep or offline. Wake it, or check that cezar is running on it.`
    : view.need ? `${view.need} in the Manager.` : null;
  return element('div', { className: 'hero' }, element('ul', { className: 'cards' }, card(server)), hint && element('p', { className: 'muted', textContent: hint }), button(primary.label, () => act(primary.action, server), 'primary'));
}

function listNodes(text) {
  const ordered = orderServers(servers, cameFrom);
  const split = wide();
  const chosen = split ? selectedId(ordered) : null;
  const leaving = removingNote(removing);
  const list = [
    titled('Your cezars'),
    element('p', { className: 'muted lead', textContent: countLine(ordered.length) }),
    notice(text),
    ordered.length === 1 && !split ? hero(ordered[0]) : element('ul', { className: 'cards' }, ...ordered.map((server) => card(server, { chosen: server.id === chosen }))),
    leaving && element('p', { className: 'muted', textContent: leaving }),
    button('Connect another cezar', () => go({ name: pairing ? 'start' : 'add' }), 'add'),
    appSection(lockRow(lock)),
  ];
  if (!split) return list;
  const server = servers.find((row) => row.id === chosen);
  return [element('div', { className: 'split' }, element('div', { className: 'pane' }, ...list), element('div', { className: 'pane detail' }, ...(server ? cezarNodes(server, { heading: true }) : [])))];
}

function drawList(text) {
  if (!servers.length) return pairing ? drawStart({}, text) : drawAdd({});
  draw(...listNodes(text));
  lockScreen = render;
  probeSoon();
}

function notifyItem(server) {
  const row = pushSwitch(server);
  if (row) {
    const input = switchInput(`${row.label} when ${server.label} needs you`, row.checked, async () => {
      try {
        const outcome = await call('pushSet', { id: server.id, enabled: row.enable });
        show(outcome);
        if (outcome.pushError) render(outcome.pushError);
      } catch (error) {
        render(String(error?.message ?? error));
      }
    });
    return item('label', row.label, { className: 'toggle' }, small(row.note), input);
  }
  return server.relay ? null : item('div', 'Notifications', {}, small('Available for cezars paired with a code.'));
}

function nameItem(server) {
  if (renaming !== server.id) {
    return item('button', 'Name', { type: 'button', onclick: () => { renaming = server.id; renameNotice = null; render(); } }, element('span', { className: 'value', textContent: server.label }));
  }
  const form = element(
    'form',
    { className: 'rename' },
    notice(renameNotice),
    field('Name', 'label', { value: server.label, maxLength: MAX_NAME, autocapitalize: 'words', required: true }),
    element('div', { className: 'actions' }, button('Cancel', () => { renaming = null; renameNotice = null; render(); }), element('button', { className: 'primary', textContent: 'Save' })),
  );
  form.onsubmit = async (event) => {
    event.preventDefault();
    const checked = checkName(new FormData(form).get('label'));
    if (checked.error) {
      renameNotice = checked.error;
      return render();
    }
    const here = stillHere();
    try {
      const outcome = await call('rename', { id: server.id, label: checked.name });
      if (!here()) return;
      renameNotice = outcome.renameError ?? null;
      if (!renameNotice) renaming = null;
      show(outcome);
    } catch (error) {
      if (!here()) return;
      renameNotice = String(error?.message ?? error);
      render();
    }
  };
  return element('div', { className: 'item editing' }, form);
}

function cezarNodes(server, { heading = false, text } = {}) {
  const view = cardFor(server, cameFrom);
  const primary = primaryFor(view);
  const where = server.relay ? 'Through the Cezar relay, end-to-end encrypted.' : `Directly, at ${view.where}.`;
  return [
    element('div', { className: 'dhead' }, avatar(server, view, 'lg'), heading ? element('h2', { className: 'title-name', textContent: view.label }) : null, pill(view), statusLine(view)),
    notice(text),
    button(primary.label, () => act(primary.action, server), 'primary'),
    eyebrow('This cezar'),
    group(notifyItem(server), nameItem(server), item('div', 'Connection', {}, small(where)), !server.relay && server.username ? item('div', 'Signed in as', {}, element('span', { className: 'value', textContent: server.username })) : null),
    group(item('button', 'Forget this cezar', { type: 'button', className: 'danger', onclick: () => go({ name: 'forget', server }) })),
    element('p', { className: 'muted', textContent: server.relay ? 'Removes this phone from it. You can pair again with a new code.' : 'Deletes its saved password from this phone.' }),
  ];
}

function drawCezar({ serverId }, text) {
  const server = servers.find((row) => row.id === serverId);
  if (!server) return drawList(text);
  if (wide()) {
    // Grown wide on this page (an iPad turned): the split shows the same cezar.
    selected = serverId;
    stack = stack.slice(0, -1);
    return render(text);
  }
  draw(titled(server.label), ...cezarNodes(server, { text }));
  lockScreen = render;
  probeSoon();
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
  const saved = servers.find((row) => row.id === server.id);
  const confirm = button(`Forget ${server.label}`, () => run('forget', { id: server.id, from: cameFrom === server.id ? null : cameFrom }, {}, 'reset'), 'destructive');
  // `from` above: Android restarts the app to drop the webview's auth cache, and the list's Back must survive that.
  const cancel = button('Cancel', () => goBack());
  if (!saved) {
    // Asked from a screen with no page under it (removed, suspended): the question is the screen.
    return draw(titled(`Forget ${server.label}?`), element('p', { textContent: forgetLead(server) }), element('div', { className: 'actions' }, cancel, confirm));
  }
  const sheet = element('div', { className: 'sheet', role: 'dialog' }, element('h2', { id: 'forget-title', textContent: `Forget ${server.label}?` }), element('p', { textContent: forgetLead(server) }), cancel, confirm);
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'forget-title');
  const under = wide() ? listNodes() : [titled(saved.label), ...cezarNodes(saved)];
  draw(...under, element('div', { className: 'scrim', onclick: (event) => event.target === event.currentTarget && goBack() }, sheet));
  cancel.focus?.({ preventScroll: true });
}

// Advanced unfolds in place and is no level of its own: Back leaves the screen, folded or not.
function drawStart({ advanced, url }, lockNotice) {
  const details = element('details', { open: Boolean(advanced) }, element('summary', { textContent: 'Use a server address instead' }), addForm({ url }));
  details.ontoggle = () => keep({ advanced: details.open });
  const first = !servers.length;
  draw(
    titled(first ? 'Connect your cezar' : 'Connect another cezar'),
    first ? element('p', { className: 'muted', textContent: 'CezarBot shows a cezar running on your laptop, a server or the cloud, so you can answer it from here.' }) : null,
    element('ol', { className: 'steps' }, element('li', { textContent: 'Open cezar, wherever it runs.' }), element('li', { textContent: 'Go to Settings, then Connect a phone.' }), element('li', { textContent: 'Scan the code it shows.' })),
    notice(lockNotice),
    element('div', { className: 'stack' }, button('Scan QR code', () => run('scan', {}, {}), 'primary'), button('Enter code', () => go({ name: 'code' }))),
    details,
    first ? appSection(startLockRow(lock), { full: false }) : null,
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

// RELAY_PROTOCOL.md § 18. The relay sends the code to the computer owner's email; the phone only helps finish.
// § 18: a status check once a minute while the screen is open, and on return to the foreground;
// confirmed (the email link, opened anywhere) opens the server at once.
const STATUS_POLL_MS = 60_000;
let statusPoll = null;
// Only the newest check's answer re-arms the poll, so overlapping checks leave one chain.
let accountCheck = 0;

function confirmScreen() {
  const top = stack.at(-1);
  return top?.name === 'confirm-email' ? top : null;
}

function checkAccount(serverId, { manual = false } = {}) {
  clearTimeout(statusPoll);
  const mine = ++accountCheck;
  return call('accountStatus', { id: serverId }).then((answer) => {
    if (mine !== accountCheck) return;
    const top = confirmScreen();
    if (top?.serverId !== serverId) return;
    if (!answer.error && accountOpens(answer, top.blocked)) {
      run('open', { id: serverId }, { serverId });
      return;
    }
    const waiting = manual && !answer.error ? 'Not confirmed yet. Open the link in the email, then check again.' : top.notice;
    keep({ status: answer.error ? (top.status ?? null) : answer, notice: answer.error ?? waiting });
    render();
    statusPoll = setTimeout(() => checkAccount(serverId), STATUS_POLL_MS);
  }, () => {});
}

function drawConfirmEmail({ serverId, blocked, status, notice: text, sent }) {
  if (status === undefined) {
    keep({ status: null });
    checkAccount(serverId);
  }
  const check = button('Check now', () => {
    check.disabled = true;
    checkAccount(serverId, { manual: true });
  }, 'primary');
  const resend = button(sent ? 'Link sent. Send another' : 'Send a new link', async () => {
    resend.disabled = true;
    const here = stillHere();
    const answer = await call('accountResend', { id: serverId }).catch((error) => ({ error: String(error?.message ?? error) }));
    if (!here()) return;
    keep({ notice: answer.error ?? `A new link is on its way${status?.email ? ` to ${status.email}` : ''}.`, sent: !answer.error });
    render();
  });
  draw(
    titled('Confirm your email'),
    notice(text),
    element('p', { textContent: confirmLead(status, blocked) }),
    element('p', { className: 'link-line', textContent: linkLine(status) }),
    element('div', { className: 'stack' }, check, resend, button('Back', () => goBack())),
    element('p', { className: 'muted', textContent: ACCOUNT_WHY }),
  );
}

function drawAccountRequired({ serverId }) {
  draw(
    titled('Set up your account in cezar'),
    element('p', { textContent: 'The relay now asks each computer for an email and accepted terms. On your computer, open cezar Settings, then Connect a phone, and enter your email. This phone does not have to pair again.' }),
    element('p', { className: 'muted', textContent: ACCOUNT_WHY }),
    element('div', { className: 'actions' }, button('Retry', () => run('open', { id: serverId }, { serverId }), 'primary')),
  );
}

const link = (text, href) => element('a', { textContent: text, href, target: '_blank', rel: 'noreferrer' });

// § 18 Phone terms: once per phone, signed with its own key, then the server opens again.
function drawDeviceTerms({ serverId, label, blocked, notice: text, version, accepted }) {
  const box = element('input', { type: 'checkbox', checked: Boolean(accepted) });
  const proceed = button('Continue', async () => {
    proceed.disabled = true;
    const here = stillHere();
    const answer = await call('deviceTerms', { id: serverId, termsVersion: version ?? RELAY_TERMS.version }).catch((error) => ({ error: String(error?.message ?? error) }));
    if (!here()) return;
    const next = termsOutcome(answer);
    if (next.open) return run('open', { id: serverId }, { serverId });
    keep(next.again ? { version: next.version, notice: next.notice, accepted: false } : { notice: next.notice });
    render();
  }, 'primary');
  proceed.disabled = !box.checked;
  box.onchange = () => {
    keep({ accepted: box.checked });
    proceed.disabled = !box.checked;
  };
  draw(
    titled('Accept the relay terms'),
    notice(text),
    element('p', { textContent: termsLead(label, blocked) }),
    element('p', {}, 'Read the ', link('Terms', RELAY_TERMS.termsUrl), ' and the ', link('Privacy Policy', RELAY_TERMS.privacyUrl), '.'),
    element('label', { className: 'check' }, box, element('span', { textContent: 'I accept the Terms and Privacy Policy' })),
    element('div', { className: 'stack' }, proceed, blocked ? null : button('Not now', () => run('open', { id: serverId }, { serverId }))),
  );
}

// § 18: only the relay operator lifts a suspension, so nothing here retries.
function drawSuspended({ serverId, label }) {
  draw(
    titled('Relay access suspended'),
    element('p', { textContent: `Relay access for ${label ?? 'this computer'} is suspended, so this phone cannot connect to it through the relay. Contact Open Mercato.` }),
    element('div', { className: 'stack' },
      button('Back to Your cezars', () => goBack(), 'primary'),
      button('Forget', () => go({ name: 'forget', server: { id: serverId, label, relay: true } })),
    ),
  );
}

function drawAdd({ url, notice: text }) {
  draw(titled(servers.length ? 'Connect another cezar' : 'Connect your cezar'), addForm({ url, notice: text }));
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

// Live status (spec 2026-11-19-mobile-devices-screen): one probe round when the list shows, on return to the
// foreground, and each minute while it stays. Only an app that sends `status` knows `probe`.
const PROBE_MS = 60_000;
let probeTimer = null;
let probing = false;
let probeOff = false;
let lastProbe = 0;

const onList = () => {
  const name = stack.at(-1)?.name ?? rootScreen({ servers, pairing });
  return !inflight && (name === 'list' || name === 'cezar');
};

function probeSoon() {
  if (probeOff || probeTimer || !servers.some((server) => server.status !== undefined)) return;
  probeTimer = setTimeout(probeNow, Math.max(0, lastProbe + PROBE_MS - Date.now()));
  probeTimer?.unref?.();
}

async function probeNow() {
  probeTimer = null;
  if (probing || document.visibilityState !== 'visible' || !onList()) return;
  probing = true;
  try {
    const outcome = await call('probe', { current: cameFrom ?? '' });
    lastProbe = Date.now();
    servers = outcome.servers ?? servers;
    notifications = outcome.notifications ?? notifications;
    version = outcome.version ?? version;
    // A name being typed keeps its field: the next round redraws.
    if (onList() && !renaming) render();
  } catch {
    probeOff = true;
  } finally {
    probing = false;
  }
  if (onList()) probeSoon();
}

// Back in the foreground: the lock row may have changed, statuses are stale, and a link may have been opened meanwhile (§ 18).
document.addEventListener('visibilitychange', () => {
  const top = confirmScreen();
  if (top && document.visibilityState === 'visible') checkAccount(top.serverId);
  if (document.visibilityState === 'visible') {
    clearTimeout(probeTimer);
    probeTimer = null;
    lastProbe = 0;
    probeSoon();
  }
  return refreshLock();
});
// An iPad turned or resized across the split's width.
wideQuery?.addEventListener?.('change', () => onList() && render());
// Native asks before its own Back: true means the page took it, false lets Android leave the app (MainActivity, ShellViewController).
window.cezarBack = () => goBack();

run('launch');
