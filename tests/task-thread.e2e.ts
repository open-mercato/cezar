import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';

import { createDoneTask, createMockTask, runStatus, statusDot, taskTitle, waitForStatus } from './helpers/mock-task.ts';

const HEADER = '[data-slot="run-header"]';
const DOCK = '[data-slot="thread-dock"]';

describe('task-thread', { tags: ['task-thread'] }, () => {
  test('the run header names the task and the thread streams the mock run to done', async ({ app, screen, browser }) => {
    const title = taskTitle('thread streams');
    const id = await createMockTask(app, screen, browser, title);
    await expect(screen.getByRole('heading', title, { level: 1 })).toBeVisible();
    // The mock's turn: a greeting, a Bash tool card, a screenshot card, the closing text.
    await expect(screen.getByRole('button', 'Ran git status --short')).toBeVisible({ timeout: 60_000 });
    await expect(screen.getByRole('button', 'Screenshot')).toBeVisible({ timeout: 60_000 });
    await waitForStatus(browser, 'done');
    await expect(statusDot(browser)).toHaveAttribute('data-tone', 'success');
    await expect(screen.getByRole('region', 'Done')).toBeVisible();
    await expect(browser.locator('[data-slot="thread-footer"]')).toContainText('Session closed');
    // The closing message renders once — no streamed shadow left beside the final frame.
    await expect(browser.locator('[data-slot="assistant-message"]').filter({ hasText: 'Anything to adjust?' })).toHaveCount(1);
    // Owner rule: finishing never flips the page to Changes on its own.
    await expect(browser).toHaveURL(new RegExp(`/tasks/${id}$`));
    await expect(browser.locator(`${HEADER} button[data-fixed="session"]`)).toHaveAttribute('aria-pressed', 'true');
    expect(await runStatus(app, id)).toBe('done');
  });

  test('the status chip wears the attention tone while the run works', async ({ app, screen, browser }) => {
    await createMockTask(app, screen, browser, taskTitle('attention tone'));
    // Live: the violet "running" dot and the Running chip; the chip is the open-state word only.
    // A busy shared server may queue the run first (workspace maxParallel), so give it time.
    await expect(statusDot(browser)).toHaveAttribute('aria-label', 'running', { timeout: 90_000 });
    await expect(statusDot(browser)).toHaveAttribute('data-tone', 'violet');
    await expect(browser.locator(`${HEADER} [data-slot="run-title-row"] [data-slot="pill"]`)).toHaveText('Running');
    await waitForStatus(browser, 'done');
    await expect(browser.locator(`${HEADER} [data-slot="run-title-row"] [data-slot="pill"]`)).toHaveCount(0);
    await expect(browser.locator(`${HEADER} [data-slot="step-tally"]`)).toHaveText('1 of 1 done');
  });

  test('Collapse header folds the details and the choice survives a reload', async ({ app, screen, browser }) => {
    await createDoneTask(app, screen, browser, 'collapse header');
    const details = browser.locator(`${HEADER} [data-slot="run-header-details"]`);
    await expect(details).toBeVisible();
    const collapse = screen.getByRole('button', 'Collapse header');
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await expect(browser.locator(`${HEADER} [data-action="collapse-header"]`)).toHaveAttribute('data-action', 'collapse-header');
    await collapse.tap();
    await expect(details).toBeHidden();
    await expect(screen.getByRole('button', 'Expand header')).toHaveAttribute('aria-expanded', 'false');
    expect(await browser.evaluate(() => localStorage.getItem('cez:run-header-collapsed'))).toBe('1');

    await browser.reload();
    await expect(screen.getByRole('button', 'Expand header')).toBeVisible({ timeout: 30_000 });
    await expect(details).toBeHidden();
    await screen.getByRole('button', 'Expand header').tap();
    await expect(details).toBeVisible();
    expect(await browser.evaluate(() => localStorage.getItem('cez:run-header-collapsed'))).toBeNull();
  });

  test('the More actions menu lists the run commands and Escape closes it', async ({ app, screen, browser }) => {
    await createDoneTask(app, screen, browser, 'actions menu');
    await screen.getByRole('button', 'More actions').tap();
    const menu = screen.getByRole('menu');
    await expect(menu).toBeVisible();
    // "Write to the agent" carries its `/` shortcut in its name.
    await expect(menu.getByRole('menuitem', 'Write to the agent', { exact: false })).toBeVisible();
    for (const item of ['Pin', 'Rename…', 'Push', 'Archive', 'Delete…']) {
      await expect(menu.getByRole('menuitem', item)).toBeVisible();
    }
    // No remote in the fixture repo: Push stays offered but greyed, with the reason.
    await expect(menu.getByRole('menuitem', 'Push')).toHaveAttribute('aria-disabled', 'true');
    await browser.keyboard.press('Escape');
    await expect(screen.getByRole('menu')).toBeHidden();
    await expect(screen.getByRole('button', 'More actions')).toHaveAttribute('aria-expanded', 'false');
  });

  test('the composer dock continues a finished run in the same thread', async ({ app, screen, browser }) => {
    await createDoneTask(app, screen, browser, 'continue flow');
    const input = screen.getByRole('textbox', 'Reply to the agent');
    await expect(input).toHaveAttribute('placeholder', 'Continue — add a prompt, or send to just reopen the session…');
    await expect(browser.locator(`${DOCK} [data-slot="composer"]`).getByRole('button', 'Continue')).toBeVisible();
    const followUp = `Follow-up from e2e ${Date.now()} mock:done`;
    await input.fill(followUp);
    await input.press('Enter');
    // A closed session cannot be resumed, so the continuation is a fresh mock session in the
    // same thread: the message lands as a user bubble and the mock's first turn plays again.
    await expect(browser.locator('[data-slot="user-bubble"]').filter({ hasText: followUp })).toBeVisible({ timeout: 30_000 });
    await expect(browser.locator('[data-slot="assistant-message"]').filter({ hasText: 'Anything to adjust?' })).toHaveCount(2, { timeout: 60_000 });
    await waitForStatus(browser, 'done');
    await expect(input).toHaveValue('');
  });

  test('the session usage chip sits bottom-right under the composer and opens the details', async ({ app, screen, browser }) => {
    await createDoneTask(app, screen, browser, 'usage chip');
    const badge = browser.locator(`${DOCK} [data-slot="session-usage"] [data-slot="agent-badge"]`);
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(/\d/);
    await expect(badge).toContainText('$');
    await expect(badge).toHaveAccessibleName(/^Agent: claude, /);
    // Right-aligned with the composer, below it.
    const composer = await browser.locator(`${DOCK} [data-slot="composer"]`).boundingBox();
    const chip = await badge.boundingBox();
    expect(chip).not.toBeNull();
    expect(composer).not.toBeNull();
    expect(chip!.x + chip!.width).toBeGreaterThanOrEqual(composer!.x + composer!.width - 8);
    expect(chip!.y).toBeGreaterThanOrEqual(composer!.y + composer!.height - 1);
    // The header carries no agent badge any more — usage lives under the composer only.
    await expect(browser.locator(`${HEADER} [data-slot="agent-badge"]`)).toHaveCount(0);

    await badge.tap();
    const details = browser.locator('[data-slot="run-usage-details"]');
    await expect(details).toBeVisible();
    await expect(details.getByText('Input tokens')).toBeVisible();
    await expect(details.getByText('Model', { exact: true })).toBeVisible();
    await expect(details.getByText('Cost')).toBeVisible();
    await browser.keyboard.press('Escape');
    await expect(details).toBeHidden();
  });

  test('the jump-to-latest pill appears when the reader scrolls up and returns them to the tail', async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 900, height: 500 });
    await createDoneTask(app, screen, browser, 'jump pill');
    const pill = screen.getByRole('button', 'Jump to latest');
    await expect(pill).toHaveCount(0);
    // A wheel gesture, not a scrollTop write: only a reader's gesture unsticks the live tail.
    await browser.locator('[data-slot="thread-rows"]').hover();
    await browser.mouse.wheel(0, -4000);
    await expect(pill).toBeVisible();
    await pill.tap();
    await expect(pill).toHaveCount(0);
    expect(
      await browser.evaluate(() => {
        const main = document.querySelector('[data-slot="workspace-stage"] [data-slot="main"]')!;
        return main.scrollHeight - main.scrollTop - main.clientHeight;
      }),
    ).toBeLessThan(80);
  });

  test('the Ask card offers the mock question and records the chosen answer', async ({ app, screen, browser }) => {
    await createMockTask(app, screen, browser, taskTitle('ask card', 'mock:ask'));
    const card = browser.locator('[data-slot="ask-card"]');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toContainText('The agent is asking');
    await expect(card.getByRole('group', 'Which date library should I standardize on?')).toBeVisible();
    await expect(card.getByRole('button', 'Other…')).toBeVisible();
    await expect(card.getByRole('button', 'Need more info')).toBeVisible();
    // The header says the run needs a human: the info tone and the Asked chip.
    await expect(statusDot(browser)).toHaveAttribute('aria-label', 'needs you');
    await expect(statusDot(browser)).toHaveAttribute('data-tone', 'info');
    await expect(browser.locator(`${HEADER} [data-slot="run-title-row"] [data-slot="pill"]`)).toHaveText('Asked');

    await card.getByRole('button', 'date-fns', { exact: false }).tap();
    await expect(card).toHaveAttribute('data-resolved', 'true', { timeout: 30_000 });
    await expect(card).toContainText('Answered');
    await expect(card).toContainText('Library: date-fns');
    await expect(screen.getByText('Follow-up #1 received', { exact: false })).toBeVisible({ timeout: 60_000 });
  });

  test('on a phone the header keeps the title and the dock, without the desktop fold', async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    const title = taskTitle('phone header');
    await createMockTask(app, screen, browser, title);
    await waitForStatus(browser, 'done');
    await expect(screen.getByRole('heading', title, { level: 1 })).toBeVisible();
    await expect(screen.getByRole('button', 'More actions')).toBeVisible();
    // Phones keep every header line; the fold is a desktop control.
    await expect(screen.getByRole('button', 'Collapse header')).toBeHidden();
    await expect(screen.getByRole('textbox', 'Reply to the agent')).toBeVisible();
    await expect(browser.locator(`${DOCK} [data-slot="session-usage"] [data-slot="agent-badge"]`)).toBeVisible();
    await expect(browser.locator(`${HEADER} button[data-fixed="session"]`)).toHaveAttribute('aria-pressed', 'true');
  });
});
