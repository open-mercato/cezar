import { describe, test, type Browser } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { TodoItem } from '@open-mercato/cezar-api-client';

/**
 * The suite boots without `CEZ_FOLLOWUPS=1`, so the real page is the "inbox is off" state. The
 * card interactions are exercised against a stubbed follow-up list: health is re-served with the
 * capability on (the WebSocket is parked so its health snapshot cannot undo the stub) and the
 * todos routes answer from an in-memory list.
 */
async function stubInbox(browser: Browser, baseUrl: string, todos: TodoItem[]) {
  await browser.addInitScript(() => {
    class ParkedSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0; onopen = null; onclose = null; onerror = null; onmessage = null;
      send() {} close() {} addEventListener() {} removeEventListener() {}
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = ParkedSocket;
  });
  await browser.route('**/api/v1/health', async (route) => {
    const real = await (await fetch(new URL('/api/v1/health', baseUrl))).json();
    await route.fulfill({ json: { ...real, capabilities: { ...real.capabilities, followups: true } } });
  });
  // The boot project answers under `/api/v1/todos`; another project under `/api/v1/p/:id/todos`.
  await browser.route(/\/api\/v1\/(p\/[^/]+\/)?todos$/, (route) =>
    route.request.method === 'GET' ? route.fulfill({ json: todos }) : route.continue(),
  );
  await browser.route(/\/api\/v1\/(p\/[^/]+\/)?todos\/[^/?]+$/, (route) => {
    if (route.request.method !== 'DELETE') return route.continue();
    const id = decodeURIComponent(route.request.url.split('/').pop() ?? '');
    const at = todos.findIndex((todo) => todo.id === id);
    if (at < 0) return route.fulfill({ status: 404, json: { error: 'not found' } });
    todos.splice(at, 1);
    return route.fulfill({ json: { removed: true } });
  });
}

function fixture(): TodoItem[] {
  const stamp = Date.now();
  return [
    { id: `e2e-run-${stamp}`, ts: new Date().toISOString(), summary: `E2E ${stamp} add tests for greet()`, action: 'follow-up', suggestedPrompt: 'Add unit tests for greet()', runnable: true },
    { id: `e2e-note-${stamp}`, ts: new Date().toISOString(), summary: `E2E ${stamp} the guide mentions a removed flag`, runnable: false },
  ];
}

describe('inbox', { tags: ['inbox'] }, () => {
  test('without CEZ_FOLLOWUPS the page says the inbox is off, not empty', async ({ app, screen, browser }) => {
    await app.open('/inbox');
    await expect(browser).toHaveURL(/\/p\/[^/]+\/inbox$/);
    await expect(screen.getByRole('heading', 'Inbox', { level: 1 })).toBeVisible();
    await expect(screen.getByText('Disabled for this server; per-task Notes still run.')).toBeVisible();
    await expect(screen.getByRole('heading', 'The follow-up inbox is off', { level: 2 })).toBeVisible();
    await expect(screen.getByText('Set CEZ_FOLLOWUPS=1', { exact: false })).toBeVisible();
    await expect(screen.getByRole('heading', 'Inbox empty')).toHaveCount(0);
  });

  test('with the capability on and nothing to read, the inbox is empty', async ({ app, screen, browser }) => {
    await stubInbox(browser, app.baseUrl!, []);
    await app.open('/inbox');
    await expect(screen.getByText('Follow-ups agents suggested when they finished a task.')).toBeVisible();
    await expect(screen.getByRole('heading', 'Inbox empty', { level: 2 })).toBeVisible();
    await expect(screen.getByText('Agents drop follow-up suggestions here when they finish a task.')).toBeVisible();
  });

  test('follow-ups render as cards with their actions', async ({ app, screen, browser }) => {
    const todos = fixture();
    await stubInbox(browser, app.baseUrl!, todos);
    await app.open('/inbox');
    await expect(screen.getByRole('listitem')).toHaveCount(2);
    const runnable = screen.getByRole('listitem').filter({ hasText: todos[0]!.summary });
    await expect(runnable.getByRole('button', 'Run')).toBeVisible();
    await expect(runnable.getByRole('button', 'Dismiss')).toBeVisible();
    await expect(runnable.getByText('follow-up')).toBeVisible();
    const note = screen.getByRole('listitem').filter({ hasText: todos[1]!.summary });
    await expect(note.getByRole('button', 'Acknowledge')).toBeVisible();
    await expect(note.getByRole('button', 'Run')).toHaveCount(0);
  });

  test('extra instructions open on demand on a runnable follow-up', async ({ app, screen, browser }) => {
    const todos = fixture();
    await stubInbox(browser, app.baseUrl!, todos);
    await app.open('/inbox');
    const runnable = screen.getByRole('listitem').filter({ hasText: todos[0]!.summary });
    await runnable.getByRole('button', /Add instructions$/).tap();
    const notes = runnable.getByRole('textbox', 'Extra instructions for this follow-up');
    await expect(notes).toBeVisible();
    await notes.fill('Keep the diff small.');
    await runnable.getByRole('button', 'Hide').tap();
    await expect(notes).toBeHidden();
  });

  test('dismiss and acknowledge check the entries off', async ({ app, screen, browser }) => {
    const todos = fixture();
    // The stub splices on DELETE, so keep the summaries before the list shrinks.
    const [first, second] = todos.map((todo) => todo.summary);
    await stubInbox(browser, app.baseUrl!, todos);
    await app.open('/inbox');
    const runnable = screen.getByRole('listitem').filter({ hasText: first });
    await runnable.getByRole('button', 'Dismiss').tap();
    await expect(runnable).toHaveCount(0);
    await expect(screen.getByRole('listitem')).toHaveCount(1);
    const note = screen.getByRole('listitem').filter({ hasText: second });
    await note.getByRole('button', 'Acknowledge').tap();
    await expect(note).toHaveCount(0);
    await expect(screen.getByRole('heading', 'Inbox empty', { level: 2 })).toBeVisible();
  });

  test('phone width keeps the cards and their actions', async ({ app, screen, browser }) => {
    const todos = fixture();
    await stubInbox(browser, app.baseUrl!, todos);
    await browser.setViewport({ width: 390, height: 844 });
    await app.open('/inbox');
    await expect(screen.getByRole('listitem')).toHaveCount(2);
    await expect(screen.getByRole('button', 'Dismiss')).toBeVisible();
    await expect(screen.getByRole('button', 'Acknowledge')).toBeVisible();
  });
});
