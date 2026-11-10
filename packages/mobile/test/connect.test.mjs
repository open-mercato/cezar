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
    draws.push(nodes[0]?.text);
    replace(...nodes);
  };
  await import(`../connect/connect.js?run=${Math.random()}`);
  for (let tick = 0; tick < 4; tick += 1) await settle();
  assert.equal(polls, 3);
  // Launch's own wait, then the pairing wait once: three more waiting answers redraw nothing.
  assert.equal(draws.length, 2);
  assert.match(draws[1], /Connecting to your computer…/);
  assert.equal(app.children[0].className, 'loading');
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
