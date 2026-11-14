import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';

import { createDoneTask, createMockTask, runStatus, statusDot, taskTitle, waitForStatus } from './helpers/mock-task.ts';

const HEADER = '[data-slot="run-header"]';
const PANEL = '[data-slot="review-panel"]';

describe('review-gate', { tags: ['review-gate'] }, () => {
  // The gate is server-wide, so this group runs on the `review-gate` target (`CEZ_REVIEW_GATE=1`,
  // see e2e.config.ts) instead of flipping a setting every other file's task would feel.
  describe('with the gate on', { serial: true, tags: ['review-gated'] }, () => {
    let id: string;
    let title: string;

    test('a run that leaves changes parks at review instead of done', async ({ app, screen, browser }) => {
      title = taskTitle('review gate');
      id = await createMockTask(app, screen, browser, title);
      await waitForStatus(browser, 'needs review');
      await expect(statusDot(browser)).toHaveAttribute('data-tone', 'info');
      await expect(browser.locator(`${HEADER} [data-slot="run-title-row"] [data-slot="pill"]`)).toHaveText('Needs review');
      await expect(browser.locator(`${HEADER} [data-slot="run-primary"]`)).toHaveText('Review changes');
      expect(await runStatus(app, id)).toBe('review');

      const panel = screen.getByRole('region', 'Review the changes');
      await expect(panel).toBeVisible();
      await expect(browser.locator('[data-slot="review-banner"]')).toContainText('Review the changes before anything lands.');
      await expect(browser.locator('[data-slot="review-banner"]')).toContainText('Nothing merges on its own.');
      // The diff is the real worktree diff: the mock's notes.md, added.
      await expect(browser.locator(`${PANEL} [data-slot="diff-file-path"]`)).toHaveText('notes.md');
      await expect(browser.locator(`${PANEL} [data-slot="diff-file-body"]`)).toContainText('mock notes');
      await expect(panel.getByRole('button', 'Send back')).toBeVisible();
      await expect(panel.getByRole('button', 'Draft PR')).toBeVisible();
      await expect(panel.getByRole('button', 'Accept')).toBeVisible();
      await expect(panel.getByRole('textbox', 'Notes for the agent')).toBeVisible();
      // Nothing has merged: the thread offers Continue, not a done card.
      await expect(screen.getByRole('region', 'Done')).toHaveCount(0);
    });

    test('Send back delivers the notes into the thread and the run gates again', async ({ app, screen, browser }) => {
      await app.open(`/tasks/${id}`);
      const panel = screen.getByRole('region', 'Review the changes');
      await expect(panel).toBeVisible({ timeout: 20_000 });
      const note = `Please also mention the port ${Date.now()} mock:done`;
      await panel.getByRole('textbox', 'Notes for the agent').fill(note);
      await panel.getByRole('button', 'Send back').tap();
      // The feedback lands as the continuation's user message, prefixed the way the agent sees it.
      const bubble = browser.locator('[data-slot="user-bubble"]').filter({ hasText: 'Review feedback:' });
      await expect(bubble).toBeVisible({ timeout: 30_000 });
      await expect(bubble).toContainText(note);
      // The gate exists only at `review`: the panel is gone while the agent works, back when it parks.
      await expect(panel).toBeHidden({ timeout: 30_000 });
      await waitForStatus(browser, 'needs review');
      await expect(panel).toBeVisible({ timeout: 20_000 });
      await expect(browser.locator(`${PANEL} [data-slot="diff-file-path"]`)).toHaveText('notes.md');
    });

    test('Accept finishes the run as done', async ({ app, screen, browser }) => {
      await app.open(`/tasks/${id}`);
      const panel = screen.getByRole('region', 'Review the changes');
      await expect(panel).toBeVisible({ timeout: 20_000 });
      await panel.getByRole('button', 'Accept').tap();
      await waitForStatus(browser, 'done');
      await expect(panel).toBeHidden();
      await expect(screen.getByRole('region', 'Done')).toBeVisible({ timeout: 20_000 });
      await expect(browser.locator('[data-slot="thread-footer"]')).toContainText('Session closed');
      expect(await runStatus(app, id)).toBe('done');
    });
  });

  test('without the gate a run with changes finishes as done and offers Review changes', async ({ app, screen, browser }) => {
    const id = await createDoneTask(app, screen, browser, 'gate off');
    await expect(browser.locator(PANEL)).toHaveCount(0);
    const done = screen.getByRole('region', 'Done');
    await expect(done).toBeVisible();
    await expect(done.getByRole('link', 'Review changes')).toHaveAttribute('href', new RegExp(`/tasks/${id}/changes$`));
    await expect(done.getByRole('button', 'Archive')).toBeVisible();
    await expect(browser.locator(`${HEADER} [data-slot="diff-stat"]`)).toContainText('+1');
  });

  test('Delete asks through the destructive alert dialog and Keep it backs out', async ({ app, screen, browser }) => {
    const title = taskTitle('delete dialog');
    const id = await createMockTask(app, screen, browser, title);
    await waitForStatus(browser, 'done');
    await screen.getByRole('button', 'More actions').tap();
    await screen.getByRole('menuitem', 'Delete…').tap();
    const dialog = screen.getByRole('alertdialog', 'Delete this task?');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('There is no undo.');
    await expect(dialog).toContainText(title);
    // The confirm wears the filled red: the destructive button variant.
    const confirm = dialog.getByRole('button', 'Delete');
    await expect(confirm).toBeVisible();
    await expect(browser).toHaveClass(confirm, /bg-danger/);
    await dialog.getByRole('button', 'Keep it').tap();
    await expect(dialog).toBeHidden();
    expect(await runStatus(app, id)).toBe('done');
    await expect(screen.getByRole('heading', title, { level: 1 })).toBeVisible();
  });

  test('Stop confirms through an alert dialog while the run is open', async ({ app, screen, browser }) => {
    // Any open run will do: the mock's first pass parks the session waiting for a reply.
    await createMockTask(app, screen, browser, taskTitle('stop dialog', ''));
    await waitForStatus(browser, 'needs you');
    await screen.getByRole('button', 'More actions').tap();
    await screen.getByRole('menuitem', 'Stop…').tap();
    const dialog = screen.getByRole('alertdialog', 'Stop this task?');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('The worktree stays.');
    await expect(browser).toHaveClass(dialog.getByRole('button', 'Stop the run'), /bg-danger/);
    await browser.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(statusDot(browser)).toHaveAttribute('aria-label', 'needs you');
  });

  test('two parallel variants settle and the Compare page sets their diffs side by side', async ({ app, screen, browser }) => {
    const title = taskTitle('compare variants');
    await app.open('/new');
    await screen.getByRole('textbox', 'Describe a task for the agent').fill(title);
    await screen.getByRole('button', 'Options').tap();
    await screen.getByRole('button', 'Parallel variants').tap();
    await screen.getByRole('menuitemradio', '×2 variants', { exact: false }).tap();
    await expect(screen.getByRole('button', 'Parallel variants')).toContainText('×2');
    await browser.keyboard.press('Escape');
    await screen.getByRole('button', 'Start task').tap();
    // Start lands on variant A; B runs beside it in its own worktree.
    await expect(browser).toHaveURL(/\/p\/[^/]+\/tasks\/[^/]+$/, { timeout: 30_000 });
    await expect(screen.getByRole('heading', `${title} (A)`, { level: 1 })).toBeVisible();
    let groupId = '';
    await expect
      .poll(
        async () => {
          const runs = (await (await fetch(new URL('/api/v1/runs', app.baseUrl))).json()) as Array<{ task: string; status: string; groupId?: string }>;
          const mine = runs.filter((run) => run.task.startsWith(title));
          groupId = mine[0]?.groupId ?? '';
          return mine.length === 2 && mine.every((run) => run.status === 'done');
        },
        { timeout: 90_000, interval: 1000 },
      )
      .toBe(true);
    expect(groupId).toMatch(/^[0-9a-f-]{36}$/);

    await app.open(`/compare/${groupId}`);
    await expect(browser).toHaveURL(new RegExp(`/p/[^/]+/compare/${groupId}$`), { timeout: 15_000 });
    await expect(screen.getByRole('heading', { level: 1 })).toContainText(title);
    await expect(screen.getByText('2 variants of the same task', { exact: false })).toBeVisible();
    const columns = browser.locator('[data-slot="compare-columns"] [data-slot="variant-column"]');
    await expect(columns).toHaveCount(2);
    await expect(browser.locator('[data-slot="variant-letter"][aria-label="Variant A"]')).toBeVisible();
    await expect(browser.locator('[data-slot="variant-letter"][aria-label="Variant B"]')).toBeVisible();
    await expect(browser.locator('[data-slot="variant-diffstat"]').first()).toContainText('notes.md');
    await expect(screen.getByRole('button', 'Pick this one')).toHaveCount(2);
    const full = screen.getByRole('region', 'Full diffs');
    await full.getByRole('button', 'Variant A — full diff').tap();
    await expect(full.getByRole('button', 'Variant A — full diff')).toHaveAttribute('aria-expanded', 'true');
    await expect(full).toContainText('mock notes');
  });
});
