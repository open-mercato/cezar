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

async function boot(lock, lockNow, launch = { servers: [saved], pairing: true, lock }) {
  const app = new Node();
  const listeners = [];
  const calls = [];
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
  };
  globalThis.window = {
    Capacitor: {
      nativePromise: async (plugin, method) => {
        calls.push(method);
        const answer = answers[method];
        if (typeof answer === 'function') return answer();
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
  return { app, calls, returned };
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
