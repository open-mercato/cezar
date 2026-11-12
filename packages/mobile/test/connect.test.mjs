import assert from 'node:assert/strict';
import test from 'node:test';

// Just enough DOM to run connect.js itself: its wiring is what a stale lock row got wrong.
class Node {
  children = [];
  attributes = {};
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  get text() {
    return [this.textContent ?? '', ...this.children.map((child) => (typeof child === 'string' ? child : child.text))].join(' ');
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const saved = { id: 'a', url: 'https://cezar.example.com', label: 'Work' };

async function boot(lock, lockNow, launch = { servers: [saved], pairing: true, lock }, more = {}) {
  const app = new Node();
  const listeners = [];
  const calls = [];
  const sent = [];
  globalThis.document = {
    visibilityState: 'visible',
    getElementById: () => app,
    createElement: (tag) => Object.assign(new Node(), { tag }),
    createElementNS: (namespace, tag) => Object.assign(new Node(), { namespace, tag }),
    addEventListener: (type, listener) => listeners.push([type, listener]),
  };
  const answers = {
    launch,
    list: () => ({ servers: [saved], pairing: true, lock: lockNow() }),
    ...more,
  };
  globalThis.window = {
    Capacitor: {
      nativePromise: async (plugin, method, options) => {
        calls.push(method);
        sent.push([method, options]);
        const answer = answers[method];
        if (typeof answer === 'function') return answer(options);
        if (answer) return answer;
        return new Promise(() => {});
      },
    },
  };
  await import(`../connect/connect.js?run=${Math.random()}`);
  await settle();
  const returned = async () => {
    for (const [type, listener] of listeners) if (type === 'visibilitychange') await listener();
    await settle();
  };
  return { app, calls, sent, returned };
}

const none = { enabled: false, available: false };
const ready = { enabled: false, available: true };

test('a screen lock set while the page was away enables the row on return', async () => {
  const { app, returned } = await boot(none, () => ready);
  assert.match(app.text, /Set a screen lock/);
  await returned();
  assert.match(app.text, /Turn on app lock/);
});

test('coming back to a hidden page asks native nothing', async () => {
  const { calls, returned } = await boot(none, () => ready);
  document.visibilityState = 'hidden';
  await returned();
  assert.deepEqual(calls, ['launch']);
});

test('returning never reruns launch, which would open a server', async () => {
  const { calls, returned } = await boot(ready, () => ready);
  await returned();
  assert.deepEqual(calls, ['launch', 'list']);
});

test('a form on screen is not replaced by the refresh', async () => {
  const { app, returned } = await boot(none, () => ready);
  const add = app.children.find((node) => node.textContent === 'Add server');
  add.onclick();
  await returned();
  assert.match(app.text, /Connect to cezar/);
  assert.doesNotMatch(app.text, /app lock/i);
});

test('where native has no lock, as on iOS, nothing is refetched', async () => {
  const { calls, returned } = await boot(undefined, () => undefined);
  await returned();
  assert.deepEqual(calls, ['launch']);
});

const find = (node, test) => (typeof node === 'string' ? null : test(node) ? node : node.children.reduce((hit, child) => hit ?? find(child, test), null));

test('a launch still in flight shows the breathing mark as a busy status, not bare text', async () => {
  const { app } = await boot(none, () => none, null);
  const wait = find(app, (node) => node.className === 'loading');
  assert.equal(wait?.attributes.role, 'status');
  assert.equal(wait.attributes['aria-busy'], 'true');
  assert.match(wait.text, /Connecting…/);
  const mark = find(wait, (node) => node.tag === 'svg');
  assert.equal(mark?.namespace, 'http://www.w3.org/2000/svg');
  assert.equal(mark.attributes['aria-hidden'], 'true');
  assert.equal(mark.children.length, 4);
});

test('a pairing poll that is still waiting keeps the same mark on screen instead of restarting it', async () => {
  const app = new Node();
  let polls = 0;
  globalThis.document = { visibilityState: 'visible', getElementById: () => app, createElement: () => new Node(), createElementNS: () => new Node(), addEventListener() {} };
  globalThis.window = {
    Capacitor: {
      nativePromise: async (plugin, method) => {
        if (method === 'launch') return { screen: 'pair', phase: 'waiting', seq: 0, servers: [], pairing: true, lock: none };
        if (method === 'pairPoll' && polls++ < 2) return { screen: 'pair', phase: 'waiting', seq: polls, servers: [], pairing: true, lock: none };
        return new Promise(() => {});
      },
    },
  };
  const draws = [];
  const replace = app.replaceChildren.bind(app);
  app.replaceChildren = (...nodes) => {
    draws.push(nodes.filter(Boolean).map((node) => node.text).join(' '));
    replace(...nodes);
  };
  await import(`../connect/connect.js?run=${Math.random()}`);
  for (let tick = 0; tick < 4; tick += 1) await settle();
  assert.equal(polls, 3);
  // Launch's own wait, then the pairing wait once: three more waiting answers redraw nothing.
  assert.equal(draws.length, 2);
  assert.match(draws[1], /Connecting to your computer…/);
  // Above the root, so the wait has its Back arrow beside the mark.
  assert.equal(app.children[0].children[0].className, 'back');
  assert.equal(app.children[1].className, 'loading');
});

const paired = { id: 'r', url: 'https://relay.example.test', label: 'Laptop', relay: true, push: false };
const isSwitch = (node) => node.attributes?.role === 'switch';

test('a relay server with push gets a Notifications switch that asks native to turn it on', async () => {
  const { app, sent } = await boot(none, () => none, { servers: [paired], pairing: true, lock: none }, {
    pushSet: ({ enabled }) => ({ servers: [{ ...paired, push: enabled }], pairing: true, lock: none }),
  });
  const input = find(app, isSwitch);
  assert.equal(input.checked, false);
  assert.match(app.text, /Notifications/);
  await input.onchange();
  assert.deepEqual(sent.at(-1), ['pushSet', { id: 'r', enabled: true }]);
  assert.equal(find(app, isSwitch).checked, true);
});

test('a refused permission comes back as a notice on the list', async () => {
  const { app } = await boot(none, () => none, { servers: [paired], pairing: true, lock: none }, {
    pushSet: () => ({ servers: [paired], pairing: true, lock: none, pushError: 'Allow notifications for Cezar in Android settings to turn this on.' }),
  });
  await find(app, isSwitch).onchange();
  assert.match(app.text, /Allow notifications/);
});

test('no switch where native sent no push, and a server still being removed is named', async () => {
  const { app } = await boot(none, () => none, { servers: [saved], pairing: true, lock: none, removing: ['Old laptop'] });
  assert.equal(find(app, isSwitch), null);
  assert.match(app.text, /Still removing Old laptop/);
});

const backArrow = (app) => find(app, (node) => node.className === 'back');

test('the Servers link from a server shows a Back arrow that reopens it', async () => {
  const { app, sent } = await boot(null, () => null, { screen: 'list', serverId: 'a', servers: [saved], pairing: true });
  const arrow = backArrow(app);
  assert.equal(arrow.attributes['aria-label'], 'Back to Work');
  arrow.onclick();
  await settle();
  assert.deepEqual(sent.at(-1), ['open', { id: 'a', quick: true }]);
});

test('Android Back and the iOS swipe take the same way back, and decline with nowhere to go', async () => {
  const { sent } = await boot(null, () => null, { screen: 'list', serverId: 'a', servers: [saved], pairing: true });
  assert.equal(window.cezarBack(), true);
  await settle();
  assert.deepEqual(sent.at(-1), ['open', { id: 'a', quick: true }]);

  const cold = await boot(null, () => null, { servers: [saved], pairing: true });
  assert.equal(backArrow(cold.app), null);
  assert.equal(window.cezarBack(), false);
});

test('no Back arrow while nothing is paired', async () => {
  const { app } = await boot(null, () => null, { screen: 'list', serverId: 'a', servers: [], pairing: true });
  assert.equal(backArrow(app), null);
  assert.equal(window.cezarBack(), false);
});

// Every path through the connect screens, by the arrow and by Android's Back / the iOS swipe (window.cezarBack).
const byText = (app, text) => find(app, (node) => node.tag === 'button' && node.textContent === text);
const title = (app) => find(app, (node) => node.tag === 'h1')?.textContent;
const form = (app) => find(app, (node) => node.tag === 'form');
const input = (app, name) => find(app, (node) => node.tag === 'input' && node.name === name);
globalThis.FormData = class {
  constructor(node) {
    this.node = node;
  }
  get(name) {
    return find(this.node, (child) => child.name === name)?.value ?? null;
  }
};
const submit = async (app, values = {}) => {
  for (const [name, value] of Object.entries(values)) input(app, name).value = value;
  form(app).onsubmit({ preventDefault() {} });
  await settle();
};
const tap = async (app, text) => {
  byText(app, text).onclick();
  await settle();
};
const arrow = async (app) => {
  backArrow(app).onclick();
  await settle();
};
const systemBack = async () => {
  const taken = window.cezarBack();
  await settle();
  return taken;
};
const two = { id: 'b', url: 'https://home.example.com', label: 'Home' };
const listed = (servers = [saved]) => ({ servers, pairing: true, lock: none });

for (const [how, back] of [['arrow', arrow], ['system Back', async () => assert.equal(await systemBack(), true)]]) {
  test(`${how}: Servers → Connect to cezar → Enter code, then back one level at a time`, async () => {
    const { app } = await boot(none, () => none, listed());
    await tap(app, 'Add server');
    assert.equal(title(app), 'Connect to cezar');
    assert.ok(backArrow(app));
    await tap(app, 'Enter code');
    assert.equal(title(app), 'Enter code');
    await back(app);
    assert.equal(title(app), 'Connect to cezar');
    await back(app);
    assert.equal(title(app), 'Servers');
    assert.equal(backArrow(app), null);
    assert.equal(window.cezarBack(), false);
  });

  test(`${how}: the cockpit's Servers link, Add server and back again, then back into the server`, async () => {
    const { app, sent } = await boot(none, () => none, { ...listed([saved, two]), screen: 'list', serverId: 'a' });
    await tap(app, 'Add server');
    await back(app);
    assert.equal(title(app), 'Servers');
    assert.equal(backArrow(app).attributes['aria-label'], 'Back to Work');
    await back(app);
    assert.deepEqual(sent.at(-1), ['open', { id: 'a', quick: true }]);
  });

  test(`${how}: with nothing paired, Connect to cezar is the root and Enter code comes back to it`, async () => {
    const { app } = await boot(none, () => none, listed([]));
    assert.equal(title(app), 'Connect to cezar');
    assert.equal(backArrow(app), null);
    await tap(app, 'Enter code');
    await back(app);
    assert.equal(title(app), 'Connect to cezar');
    assert.equal(backArrow(app), null);
    assert.equal(window.cezarBack(), false);
  });

  test(`${how}: a server that fails to open, then back to the list`, async () => {
    const { app } = await boot(none, () => none, listed(), { open: { ...listed(), screen: 'connection-error', serverId: 'a' } });
    await find(app, (node) => node.className === 'open').onclick();
    await settle();
    assert.equal(title(app), 'Connection problem');
    await back(app);
    assert.equal(title(app), 'Servers');
  });
}

test('Advanced unfolds in place: Back leaves Connect to cezar folded or not', async () => {
  const { app } = await boot(none, () => none, listed());
  await tap(app, 'Add server');
  const details = find(app, (node) => node.tag === 'details');
  details.open = true;
  details.ontoggle();
  assert.equal(await systemBack(), true);
  assert.equal(title(app), 'Servers');
});

test('Advanced → Sign in → Back returns to Connect to cezar with Advanced open and the address kept', async () => {
  const { app } = await boot(none, () => none, listed(), { add: ({ url }) => ({ ...listed(), screen: 'ask-credentials', url }) });
  await tap(app, 'Add server');
  const details = find(app, (node) => node.tag === 'details');
  details.open = true;
  details.ontoggle();
  await submit(app, { url: 'https://new.example.com' });
  assert.equal(title(app), 'Sign in');
  await arrow(app);
  assert.equal(title(app), 'Connect to cezar');
  assert.equal(find(app, (node) => node.tag === 'details').open, true);
  assert.equal(input(app, 'url').value, 'https://new.example.com');
});

test('a cancelled scan leaves Connect to cezar on screen', async () => {
  const { app } = await boot(none, () => none, listed(), { scan: () => listed() });
  await tap(app, 'Add server');
  await tap(app, 'Scan QR code');
  assert.equal(title(app), 'Connect to cezar');
  assert.equal(await systemBack(), true);
  assert.equal(title(app), 'Servers');
});

test('Back while connecting to the computer cancels the pairing and returns to Enter code, code kept', async () => {
  const { app, sent } = await boot(none, () => none, { ...listed(), relayDefault: 'https://relay.example.test' }, {
    pairCode: { ...listed(), screen: 'pair', phase: 'waiting', seq: 0 },
    pairCancel: () => listed(),
  });
  await tap(app, 'Add server');
  await tap(app, 'Enter code');
  await submit(app, { code: 'ABCD-EFGH-JKLM' });
  assert.ok(find(app, (node) => node.className === 'loading'));
  assert.ok(backArrow(app));
  assert.equal(await systemBack(), true);
  await settle();
  assert.deepEqual(sent.at(-1), ['pairCancel', {}]);
  assert.equal(title(app), 'Enter code');
  assert.equal(input(app, 'code').value, 'ABCD-EFGH-JKLM');
  // The default relay is no change of the user's: Advanced stays folded.
  assert.equal(find(app, (node) => node.tag === 'details').open, false);
});

test('Back over the six digits asks first; Back again keeps pairing; Stop pairing cancels', async () => {
  const { app, calls } = await boot(none, () => none, listed([]), {
    scan: { ...listed([]), screen: 'pair', phase: 'confirm', digits: '123456', label: 'Laptop', seq: 1 },
    pairCancel: () => listed([]),
  });
  await tap(app, 'Scan QR code');
  assert.equal(title(app), 'Confirm on your computer');
  assert.equal(await systemBack(), true);
  assert.match(app.text, /Stop pairing\?/);
  assert.ok(!calls.includes('pairCancel'));
  assert.equal(await systemBack(), true);
  assert.doesNotMatch(app.text, /Stop pairing\?/);
  assert.match(app.text, /123456/);
  await arrow(app);
  await tap(app, 'Stop pairing');
  await settle();
  assert.ok(calls.includes('pairCancel'));
  assert.equal(title(app), 'Connect to cezar');
  assert.equal(window.cezarBack(), false);
});

test('a late poll answer after Back is dropped, not drawn', async () => {
  let answer;
  const { app } = await boot(none, () => none, listed(), {
    pairCode: { ...listed(), screen: 'pair', phase: 'waiting', seq: 0 },
    pairPoll: () => new Promise((resolve) => (answer = resolve)),
    pairCancel: () => listed(),
  });
  await tap(app, 'Add server');
  await tap(app, 'Enter code');
  await submit(app, { code: 'ABCD-EFGH-JKLM' });
  await systemBack();
  await settle();
  answer({ ...listed(), screen: 'pair', phase: 'confirm', digits: '999999', label: 'Laptop', seq: 1 });
  await settle();
  assert.equal(title(app), 'Enter code');
});

test('a failed pairing: Try again and Back both return to the screen that started it', async () => {
  const { app } = await boot(none, () => none, listed(), { pairCode: { ...listed(), screen: 'pair', phase: 'failed', reason: 'expired' } });
  await tap(app, 'Add server');
  await tap(app, 'Enter code');
  await submit(app, { code: 'ABCD-EFGH-JKLM' });
  assert.equal(title(app), 'Not paired');
  await tap(app, 'Try again');
  assert.equal(title(app), 'Enter code');
  await submit(app, { code: 'ABCD-EFGH-JKLM' });
  await arrow(app);
  assert.equal(title(app), 'Enter code');
});

test('Back from a request still running abandons it and shows the screen below', async () => {
  const { app } = await boot(none, () => none, listed(), { open: () => new Promise(() => {}) });
  find(app, (node) => node.className === 'open').onclick();
  await settle();
  assert.ok(find(app, (node) => node.className === 'loading'));
  assert.equal(await systemBack(), true);
  assert.equal(title(app), 'Servers');
});

test('Forget of the last server lands on Connect to cezar as the root', async () => {
  const { app, sent } = await boot(none, () => none, listed(), { forget: () => listed([]) });
  await tap(app, 'Forget');
  assert.equal(title(app), 'Forget Work?');
  assert.ok(backArrow(app));
  await tap(app, 'Forget server');
  assert.deepEqual(sent.at(-1), ['forget', { id: 'a', from: null }]);
  assert.equal(title(app), 'Connect to cezar');
  assert.equal(backArrow(app), null);
  assert.equal(window.cezarBack(), false);
});

test('Forget of one of several stays on the list, still going back to the server it came from', async () => {
  const { app, sent } = await boot(none, () => none, { ...listed([saved, two]), screen: 'list', serverId: 'a' }, { forget: () => listed([saved]) });
  find(app, (node) => node.tag === 'li' && node.text.includes('Home')).children.find((node) => node.textContent === 'Forget').onclick();
  await settle();
  await tap(app, 'Forget server');
  // Android restarts the app to drop the auth cache; `from` carries the way back through it.
  assert.deepEqual(sent.at(-1), ['forget', { id: 'b', from: 'a' }]);
  assert.equal(title(app), 'Servers');
  assert.equal(backArrow(app).attributes['aria-label'], 'Back to Work');
});

test('Cancel on Forget is one level back', async () => {
  const { app } = await boot(none, () => none, listed());
  await tap(app, 'Forget');
  await tap(app, 'Cancel');
  assert.equal(title(app), 'Servers');
});

test('a removed phone: Pair again and back, then back to the list', async () => {
  const { app } = await boot(none, () => none, listed(), { open: { ...listed(), screen: 'device-removed', serverId: 'a' } });
  await find(app, (node) => node.className === 'open').onclick();
  await settle();
  await tap(app, 'Pair again');
  assert.equal(title(app), 'Connect to cezar');
  await systemBack();
  assert.equal(title(app), 'This phone was removed from cezar.');
  await systemBack();
  assert.equal(title(app), 'Servers');
});
