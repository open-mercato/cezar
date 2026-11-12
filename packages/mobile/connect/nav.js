// The connect page's navigation stack: every screen above the root pops one level, by the arrow,
// Android's Back or the iOS edge swipe alike. Plain arrays in, plain arrays out; no DOM here.

// One pairing occupies one level: its phases replace each other instead of stacking.
const PAIR = new Set(['pair-waiting', 'pair-confirm', 'pair-failed']);
const kind = (entry) => (PAIR.has(entry?.name) ? 'pair' : entry?.name);

/** The bottom of the stack: the Servers list once a server is paired, else Connect to cezar. */
export const rootScreen = ({ servers, pairing }) => (servers?.length ? 'list' : pairing ? 'start' : 'add');

/** A native answer that means "show the root", rather than a screen of its own. */
const isRoot = (screen) => screen.name === 'list' || screen.name === 'start' || (screen.name === 'add' && !screen.notice);

/**
 * Puts a native answer on the stack. `how` says what asked: `reset` (launch, Forget) rebuilds from the
 * root, `cancel` (a stopped pairing) drops the pairing level, `stay` (any other action) keeps the screen
 * that asked, so a cancelled scan or a toggled switch leaves the user where they were.
 */
export function settle(stack, screen, { how = 'stay', root }) {
  if (screen.name === 'busy') return stack;
  const base = stack.length && stack[0].name === root ? stack : [{ name: root }];
  if (isRoot(screen)) {
    if (how === 'reset') return [{ name: root }];
    if (how === 'cancel') return dropPairing(base);
    return base;
  }
  const top = base.at(-1);
  // A redrawn form or the next pairing phase replaces its own level.
  if (kind(top) === kind(screen)) return [...base.slice(0, -1), screen];
  return [...base, screen];
}

/** Leaves the pairing level, back to the screen that started it. */
export function dropPairing(stack) {
  let end = stack.length;
  while (end > 1 && PAIR.has(stack[end - 1].name)) end -= 1;
  return stack.slice(0, end);
}

/**
 * What Back does now. `last` is the server the list returns to, while it is still paired;
 * `confirming` is the "Stop pairing?" question over the six digits.
 */
export function backAction(stack, { last, confirming } = {}) {
  const top = stack.at(-1);
  if (top?.name === 'pair-waiting') return { do: 'cancel-pairing' };
  if (top?.name === 'pair-confirm') return { do: confirming ? 'keep-pairing' : 'confirm-cancel' };
  if (stack.length > 1) return { do: 'pop' };
  if (top?.name === 'list' && last) return { do: 'open', id: last };
  return { do: 'exit' };
}

/** The root shows no arrow unless the list has a server to return to. */
export const hasArrow = (stack, env) => backAction(stack, env).do !== 'exit';
