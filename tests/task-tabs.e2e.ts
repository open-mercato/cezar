import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';

import { ACTIVE_LAYOUT, createDoneTask, createMockTask, statusDot, taskTitle, waitForStatus } from './helpers/mock-task.ts';

const HEADER = '[data-slot="run-header"]';
const card = (view: string) => `${HEADER} [data-slot="run-tabs"] button[data-fixed="${view}"]`;

/** Deep links switch the active layout; the keep-alive layouts stay mounted beside it. */
async function openView(app: Parameters<Parameters<typeof test>[1]>[0]['app'], browser: Parameters<Parameters<typeof test>[1]>[0]['browser'], id: string, view: string) {
  await app.open(`/tasks/${id}/${view}`);
  await expect(browser).toHaveURL(new RegExp(`/p/[^/]+/tasks/${id}/${view}$`), { timeout: 15_000 });
  await expect(browser.locator(ACTIVE_LAYOUT)).toHaveCount(1, { timeout: 20_000 });
  // A CSS locator has no CSS child query, so the active layout is a prefix, not a scope.
  return { layout: browser.locator(ACTIVE_LAYOUT), at: (css: string) => browser.locator(`${ACTIVE_LAYOUT} ${css}`) };
}

describe('task-tabs', { tags: ['task-tabs'] }, () => {
  test('finishing a run leaves the page on the chat tab', async ({ app, screen, browser }) => {
    const id = await createMockTask(app, screen, browser, taskTitle('stays on chat'));
    await waitForStatus(browser, 'done');
    await expect(browser).toHaveURL(new RegExp(`/tasks/${id}$`));
    await expect(browser.locator(card('session'))).toHaveAttribute('aria-pressed', 'true');
    await expect(browser.locator(card('changes'))).toHaveAttribute('aria-pressed', 'false');
    // The badge tells the reader there is something to review without opening it for them.
    await expect(browser.locator(`${card('changes')} [data-slot="tab-badge"]`)).toHaveText('1');
  });

  test('the Changes view shows the changed-file tree and the diff', async ({ app, screen, browser }) => {
    const id = await createDoneTask(app, screen, browser, 'changes view');
    const { layout, at } = await openView(app, browser, id, 'changes');
    await expect(layout.getByRole('navigation', 'Changed files')).toBeVisible({ timeout: 20_000 });
    await expect(at('[data-slot="tree-file"]').filter({ hasText: 'notes.md' })).toBeVisible();
    await expect(at('[data-slot="diff-file-path"]')).toHaveText('notes.md');
    await expect(at('[data-slot="diff-file-body"]')).toContainText('mock notes');
    await expect(layout.getByRole('button', 'Wrap long lines')).toBeVisible();
    // The mock writes one source-like file and no cruft, so no junk fold is offered.
    await expect(at('[data-slot="tree-junk-fold"]')).toHaveCount(0);
  });

  test('the Files view browses the worktree and opens src/greet.ts', async ({ app, screen, browser }) => {
    const id = await createDoneTask(app, screen, browser, 'files view');
    const { layout, at } = await openView(app, browser, id, 'files');
    await expect(layout.getByRole('navigation', 'Worktree files')).toBeVisible({ timeout: 20_000 });
    await expect(at('[data-slot="files-file"]').filter({ hasText: 'README.md' })).toBeVisible();
    await at('[data-slot="files-dir"]').filter({ hasText: 'src' }).tap();
    const greet = at('[data-slot="files-file"]').filter({ hasText: 'greet.ts' });
    await expect(greet).toBeVisible();
    await greet.tap();
    const preview = layout.getByRole('region', 'File preview');
    await expect(at('[data-slot="file-preview-code"]')).toBeVisible({ timeout: 20_000 });
    await expect(preview).toContainText('export function greet');
    await expect(at('[data-slot="file-preview-head"]')).toContainText('greet.ts');
  });

  test('the Graph view renders the workflow canvas', async ({ app, screen, browser }) => {
    const id = await createDoneTask(app, screen, browser, 'graph view');
    const { layout, at } = await openView(app, browser, id, 'graph');
    await expect(layout.getByRole('button', 'Fit View')).toBeVisible({ timeout: 20_000 });
    await expect(layout.getByRole('button', 'Zoom In')).toBeVisible();
    await expect(at('[data-slot="status-dot"][aria-label="done"]')).toBeVisible();
  });

  test('the Commits view lists the autosave commit and opens it', async ({ app, screen, browser }) => {
    const id = await createDoneTask(app, screen, browser, 'commits view');
    const { layout, at } = await openView(app, browser, id, 'commits');
    const row = at('[data-slot="commit-row"]');
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(row).toContainText('cezar autosave (run finalize)');
    const sha = await row.getAttribute('data-sha');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // Inside the workspace a row opens the commit in its own column; the URL stays put.
    await row.tap();
    await expect(layout.getByRole('heading', 'cezar autosave (run finalize)', { level: 2 })).toBeVisible({ timeout: 20_000 });
    await expect(at('[data-slot="diff-file-path"]')).toContainText('notes.md');
    await expect(browser).toHaveURL(new RegExp(`/tasks/${id}/commits$`));
    await layout.getByRole('button', 'All commits').tap();
    await expect(row).toBeVisible();
    // The commit's own page answers the deep link.
    await app.open(`/tasks/${id}/commits/${sha}`);
    await expect(browser).toHaveURL(new RegExp(`/tasks/${id}/commits/${sha}$`), { timeout: 15_000 });
    const commit = browser.locator('[data-slot="task-commit"]');
    await expect(commit.getByRole('heading', 'cezar autosave (run finalize)', { level: 2 })).toBeVisible({ timeout: 20_000 });
    await expect(browser.locator('[data-slot="task-commit"] [data-slot="diff-file-path"]')).toContainText('notes.md');
    await browser.locator('[data-slot="commit-back"]').tap();
    await expect(browser).toHaveURL(new RegExp(`/tasks/${id}/commits$`), { timeout: 15_000 });
  });

  test('the Notes view shows the handoff journal and keeps it across a reload', async ({ app, screen, browser }) => {
    const title = taskTitle('notes view');
    const id = await createMockTask(app, screen, browser, title);
    await waitForStatus(browser, 'done');
    await app.open(`/tasks/${id}/notes`);
    await expect(browser).toHaveURL(new RegExp(`/tasks/${id}/notes$`));
    const notes = browser.locator('[data-slot="notes-panel"]');
    await expect(notes.getByRole('heading', `Handoff — ${title}`, { level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(notes.getByRole('heading', 'Progress log', { level: 2 })).toBeVisible();
    await expect(notes).toContainText('mock: implemented the change (dry run)');
    await browser.reload();
    await expect(notes.getByRole('heading', `Handoff — ${title}`, { level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(notes).toContainText('mock: implemented the change (dry run)');
    // The notes page wears the same tab row; Notes is the current one.
    await expect(screen.getByRole('link', 'Notes')).toHaveAttribute('aria-current', 'page');
  });

  test('the Preview view opens the in-cockpit browser', async ({ app, screen, browser }) => {
    const id = await createDoneTask(app, screen, browser, 'preview view');
    const { layout, at } = await openView(app, browser, id, 'preview');
    await expect(at('[data-slot="browser-view"]')).toBeVisible({ timeout: 20_000 });
    await expect(layout.getByRole('tablist', 'Browser tabs')).toBeVisible();
    await expect(layout.getByRole('button', 'Reload')).toBeVisible();
    await expect(layout.getByRole('button', 'Back')).toBeVisible();
  });

  test('the Assets view shows the report the mock wrote', async ({ app, screen, browser }) => {
    const id = await createDoneTask(app, screen, browser, 'assets view');
    await expect(browser.locator(`${card('assets')} [data-slot="tab-badge"]`)).toHaveText('1');
    const { layout, at } = await openView(app, browser, id, 'assets');
    await expect(at('[data-slot="assets-view"]')).toBeVisible({ timeout: 20_000 });
    await expect(layout.getByRole('button', 'Asset: Dry-run demo report — switch asset')).toBeVisible({ timeout: 20_000 });
    await expect(at('[data-slot="assets-frame"]')).toBeVisible();
    await expect(at('[data-slot="assets-sandboxed"]')).toBeVisible();
    await expect(layout.getByRole('button', 'Reload')).toBeVisible();
  });

  test('the Terminal view opens a shell, or says why it cannot', async ({ app, screen, browser }) => {
    const id = await createDoneTask(app, screen, browser, 'terminal view');
    const health = (await (await fetch(new URL('/api/v1/health', app.baseUrl))).json()) as { capabilities?: { terminal?: boolean } };
    if (health.capabilities?.terminal !== true) {
      await expect(browser.locator(card('terminal'))).toHaveCount(0);
      return;
    }
    const { layout, at } = await openView(app, browser, id, 'terminal');
    await expect(layout.getByRole('region', 'Terminal')).toBeVisible({ timeout: 20_000 });
    const screenOrReason = at('[data-slot="terminal-screen"], [data-slot="terminal-unavailable"]');
    await expect(screenOrReason.first()).toBeVisible({ timeout: 30_000 });
    if (await at('[data-slot="terminal-unavailable"]').isVisible()) {
      await expect(at('[data-slot="terminal-unavailable"]')).toContainText(/./);
      return;
    }
    await expect(layout.getByRole('tablist', 'Terminal tabs')).toBeVisible();
    await expect(layout.getByRole('button', 'New terminal tab')).toBeVisible();
    await expect(layout.getByRole('button', 'Close Terminal 1')).toBeVisible();
  });

  test('the strip switches views in place and the keyboard steps through them', async ({ app, screen, browser }) => {
    const id = await createDoneTask(app, screen, browser, 'strip keyboard');
    await browser.locator(card('changes')).tap();
    await expect(browser.locator(card('changes'))).toHaveAttribute('aria-pressed', 'true');
    await expect(browser).toHaveURL(new RegExp(`/tasks/${id}$`));
    await expect(browser.locator(`${ACTIVE_LAYOUT} [data-slot="diff-file-path"]`)).toBeVisible({ timeout: 20_000 });
    // `]` steps to the next card, `1` jumps to the numbered tab (the run header's own shortcuts).
    await browser.keyboard.press(']');
    await expect(browser.locator(card('commits'))).toHaveAttribute('aria-pressed', 'true');
    await browser.keyboard.press('[');
    await expect(browser.locator(card('changes'))).toHaveAttribute('aria-pressed', 'true');
    await browser.keyboard.press('1');
    await expect(browser.locator(card('session'))).toHaveAttribute('aria-pressed', 'true');
    await expect(screen.getByRole('textbox', 'Reply to the agent')).toBeVisible();
  });

  test('on a phone the tab strip still switches to Changes', async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    const id = await createDoneTask(app, screen, browser, 'phone tabs');
    await expect(statusDot(browser)).toBeVisible();
    await browser.locator(card('changes')).tap();
    await expect(browser.locator(card('changes'))).toHaveAttribute('aria-pressed', 'true');
    await expect(browser.locator(`${ACTIVE_LAYOUT} [data-slot="diff-file-path"]`)).toBeVisible({ timeout: 20_000 });
    await expect(browser).toHaveURL(new RegExp(`/tasks/${id}$`));
  });
});
