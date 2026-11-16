import assert from 'node:assert/strict';
import test from 'node:test';
import { backAction, dropPairing, hasArrow, rootScreen, settle } from '../connect/nav.js';

const names = (stack) => stack.map((entry) => entry.name);
const list = [{ name: 'list' }];

test('the root is the list once a server is paired, else Connect to cezar', () => {
  assert.equal(rootScreen({ servers: [{ id: 'a' }], pairing: true }), 'list');
  assert.equal(rootScreen({ servers: [], pairing: true }), 'start');
  // An app without a relay client connects by address.
  assert.equal(rootScreen({ servers: [], pairing: false }), 'add');
});

test('the root list goes back to the last server while it is paired, else Back leaves the app', () => {
  assert.deepEqual(backAction(list, { last: 'a' }), { do: 'open', id: 'a' });
  assert.deepEqual(backAction(list, {}), { do: 'exit' });
  assert.equal(hasArrow(list, { last: 'a' }), true);
  assert.equal(hasArrow(list, {}), false);
});

test('Connect to cezar as the root has no arrow and Back leaves the app, never nothing', () => {
  for (const root of ['start', 'add']) {
    assert.deepEqual(backAction([{ name: root }], { last: 'a' }), { do: 'exit' });
    assert.equal(hasArrow([{ name: root }], {}), false);
  }
  assert.deepEqual(backAction([], {}), { do: 'exit' });
});

test('every screen above the root pops one level', () => {
  for (const name of ['start', 'add', 'code', 'credentials', 'error', 'forget', 'removed', 'pair-failed']) {
    const stack = [...list, { name: 'start' }, { name }];
    assert.deepEqual(backAction(stack, {}), { do: 'pop' }, name);
    assert.equal(hasArrow(stack, {}), true, name);
  }
});

test('a pairing in progress cancels, and asks first once the six digits are up', () => {
  const waiting = [...list, { name: 'start' }, { name: 'pair-waiting' }];
  assert.deepEqual(backAction(waiting, {}), { do: 'cancel-pairing' });
  const confirm = [{ name: 'start' }, { name: 'pair-confirm', digits: '123456' }];
  assert.deepEqual(backAction(confirm, {}), { do: 'confirm-cancel' });
  // Back again over the question keeps pairing, as Back closes a dialog.
  assert.deepEqual(backAction(confirm, { confirming: true }), { do: 'keep-pairing' });
});

test('a native screen pushes one level; its own redraw and the next pairing phase replace it', () => {
  let stack = [...list, { name: 'start' }];
  stack = settle(stack, { name: 'pair-waiting', seq: 0 }, { root: 'list' });
  stack = settle(stack, { name: 'pair-waiting', seq: 1 }, { root: 'list' });
  stack = settle(stack, { name: 'pair-confirm', digits: '1' }, { root: 'list' });
  assert.deepEqual(names(stack), ['list', 'start', 'pair-confirm']);
  stack = settle(stack, { name: 'pair-failed', message: 'x' }, { root: 'list' });
  assert.deepEqual(names(stack), ['list', 'start', 'pair-failed']);
  assert.deepEqual(names(dropPairing(stack)), ['list', 'start']);

  let signIn = settle([...list, { name: 'start' }], { name: 'credentials', url: 'u' }, { root: 'list' });
  signIn = settle(signIn, { name: 'credentials', url: 'u', notice: 'Password rejected.' }, { root: 'list' });
  assert.deepEqual(names(signIn), ['list', 'start', 'credentials']);
  assert.equal(signIn.at(-1).notice, 'Password rejected.');
});

test('a refused address on the root form stays the root', () => {
  const stack = settle([{ name: 'add' }], { name: 'add', notice: 'Not cezar.' }, { root: 'add' });
  assert.deepEqual(names(stack), ['add']);
  assert.deepEqual(backAction(stack, {}), { do: 'exit' });
});

test('a cancelled scan or a toggled switch leaves the screen that asked on top', () => {
  const stack = [...list, { name: 'start' }];
  assert.equal(settle(stack, { name: 'list' }, { root: 'list' }), stack);
});

test('a cancelled pairing returns to the screen that started it', () => {
  const stack = [...list, { name: 'start' }, { name: 'code', code: 'ABCD' }, { name: 'pair-confirm' }];
  assert.deepEqual(settle(stack, { name: 'list' }, { how: 'cancel', root: 'list' }), stack.slice(0, 3));
});

test('Forget rebuilds from the root: the list with servers left, Connect to cezar without', () => {
  const stack = [...list, { name: 'forget' }];
  assert.deepEqual(names(settle(stack, { name: 'list' }, { how: 'reset', root: 'list' })), ['list']);
  assert.deepEqual(names(settle(stack, { name: 'start' }, { how: 'reset', root: 'start' })), ['start']);
});

test('a root that changed under the stack is rebuilt rather than kept stale', () => {
  const stack = [...list, { name: 'start' }];
  assert.deepEqual(names(settle(stack, { name: 'start' }, { root: 'start' })), ['start']);
  assert.deepEqual(names(settle([], { name: 'error', message: 'x' }, { root: 'list' })), ['list', 'error']);
});

test('the transient "Opening…" wait never touches the stack', () => {
  const stack = [...list, { name: 'error' }];
  assert.equal(settle(stack, { name: 'busy' }, { root: 'list' }), stack);
});
