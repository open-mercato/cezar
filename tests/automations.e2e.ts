import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Serial: the explainer only shows while the list is empty, and the lifecycle below
// creates one automation and deletes it at the end.
describe('automations', { tags: ['automations'], serial: true }, () => {
  const name = `E2E ${Date.now()} nightly`;

  test('the empty list opens on the explainer under the title row and toolbar', async ({ app, screen, browser }) => {
    await app.open('/automations');
    await expect(browser).toHaveURL(/\/p\/[^/]+\/automations$/);
    await expect(screen.getByRole('heading', 'Automations', { level: 1 })).toBeVisible();
    await expect(screen.getByRole('group', 'View')).toBeVisible();
    await expect(screen.getByRole('button', /^List/)).toHaveAttribute('aria-pressed', 'true');
    await expect(screen.getByRole('button', 'Week')).toBeVisible();
    await expect(screen.getByRole('button', 'Day')).toBeVisible();
    await expect(screen.getByRole('link', 'New automation').first()).toBeVisible();
    await expect(screen.getByRole('heading', 'Let the routine run itself', { level: 2 })).toBeVisible();
    await expect(screen.getByRole('button', /^Start here On a schedule/)).toBeVisible();
    await expect(screen.getByRole('button', /^When an issue moves/)).toBeVisible();
    // No GitHub remote in the fixture: the tile says so instead of opening the editor.
    await expect(screen.getByRole('button', /^When GitHub changes Sign in to the GitHub CLI first/)).toBeVisible();
  });

  test('the toolbar has one ⋯ menu with export, import and the guide', async ({ app, screen }) => {
    await app.open('/automations');
    await expect(screen.getByRole('button', 'More actions')).toHaveCount(1);
    await screen.getByRole('button', 'More actions').tap();
    await expect(screen.getByRole('menu')).toBeVisible();
    await expect(screen.getByRole('menuitem', 'Export automations')).toBeVisible();
    await expect(screen.getByRole('menuitem', 'Import automations…')).toBeVisible();
    await screen.getByRole('menuitem', 'How automations work').tap();
    await expect(screen.getByRole('dialog')).toBeVisible();
    await expect(screen.getByRole('heading', 'How automations work')).toBeVisible();
    await screen.getByRole('dialog').press('Escape');
    await expect(screen.getByRole('dialog')).toBeHidden();
  });

  test('a scheduled automation is created from the editor and lands in the list paused', async ({ app, screen, browser }) => {
    await app.open('/automations/new');
    await expect(screen.getByRole('heading', 'New automation', { level: 1 })).toBeVisible();
    await expect(screen.getByRole('button', 'Save paused')).toBeDisabled();
    await screen.getByRole('button', 'Hide templates').tap();
    await expect(screen.getByRole('button', 'Start from a template')).toBeVisible();

    await expect(screen.getByRole('button', 'On a schedule')).toHaveAttribute('aria-pressed', 'true');
    await screen.getByRole('button', 'Weekdays').tap();
    await screen.getByRole('textbox', 'Hour').fill('9');
    await screen.getByRole('textbox', 'Minute').fill('30');
    await expect(screen.getByText('30 9 * * 1-5')).toBeVisible();

    await screen.getByRole('textbox', 'Name').fill(name);
    await screen.getByRole('textbox', 'Prompt').fill('Say hello and stop. (e2e)');
    await expect(screen.getByRole('button', 'Save paused')).toBeEnabled();
    // The go-live switch renames the primary action; it stays paused for the rest of the suite.
    await screen.getByRole('switch', 'Enabled').tap();
    await expect(screen.getByRole('button', 'Save and enable')).toBeVisible();
    await screen.getByRole('switch', 'Enabled').tap();
    await screen.getByRole('button', 'Save paused').tap();

    await expect(browser).toHaveURL(/\/p\/[^/]+\/automations$/);
    const row = screen.getByRole('row').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row.getByText('paused')).toBeVisible();
    await expect(row).toContainText('09:30');
    await expect(screen.getByRole('button', /^List 1$/)).toBeVisible();
  });

  test('enable and pause flip the state pill', async ({ app, screen }) => {
    await app.open('/automations');
    const row = screen.getByRole('row').filter({ hasText: name });
    await row.getByRole('button', 'Enable').tap();
    await expect(row.getByText('enabled')).toBeVisible();
    await expect(row.getByRole('button', 'Pause')).toBeVisible();
    await row.getByRole('button', 'Pause').tap();
    await expect(row.getByText('paused')).toBeVisible();
    await expect(row.getByRole('button', 'Enable')).toBeVisible();
  });

  test('the row opens its editor with the kind locked', async ({ app, screen, browser }) => {
    await app.open('/automations');
    await screen.getByRole('row').filter({ hasText: name }).getByText(name).tap();
    await expect(browser).toHaveURL(/\/p\/[^/]+\/automations\/[^/]+$/);
    await expect(screen.getByRole('heading', 'Edit automation', { level: 1 })).toBeVisible();
    await expect(screen.getByRole('textbox', 'Name')).toHaveValue(name);
    await expect(screen.getByRole('button', 'When Jira / Linear changes')).toBeDisabled();
    await expect(screen.getByRole('button', 'Save changes')).toBeVisible();
    await screen.getByRole('button', 'Back').tap();
    await expect(browser).toHaveURL(/\/p\/[^/]+\/automations$/);
  });

  test('the log page opens empty from the row menu', async ({ app, screen, browser }) => {
    await app.open('/automations');
    const row = screen.getByRole('row').filter({ hasText: name });
    await row.getByRole('button', 'More').tap();
    await screen.getByRole('menuitem', 'View log').tap();
    await expect(browser).toHaveURL(/\/p\/[^/]+\/automations\/[^/]+\/log$/);
    await expect(screen.getByRole('heading', name, { level: 1 })).toBeVisible();
    await expect(screen.getByText('No checks have run yet.')).toBeVisible();
    await expect(screen.getByRole('combobox', 'Filter by result')).toBeVisible();
    await expect(screen.getByRole('combobox', 'Filter by event')).toBeVisible();
    await screen.getByRole('button', 'Back').tap();
    await expect(browser).toHaveURL(/\/p\/[^/]+\/automations$/);
  });

  test('run now queues a task from the row', async ({ app, screen }) => {
    await app.open('/automations');
    const row = screen.getByRole('row').filter({ hasText: name });
    await row.getByRole('button', 'Run now').tap();
    await expect(screen.getByRole('status').filter({ hasText: `Started "${name}"` })).toBeVisible();
  });

  test('delete asks first, then removes the automation', async ({ app, screen }) => {
    await app.open('/automations');
    const row = screen.getByRole('row').filter({ hasText: name });
    await row.getByRole('button', 'More').tap();
    await screen.getByRole('menuitem', 'Delete').tap();
    const dialog = screen.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', `Delete “${name}”?`)).toBeVisible();
    await dialog.getByRole('button', 'Cancel').tap();
    await expect(dialog).toBeHidden();
    await expect(row).toBeVisible();

    await row.getByRole('button', 'More').tap();
    await screen.getByRole('menuitem', 'Delete').tap();
    await screen.getByRole('alertdialog').getByRole('button', 'Delete').tap();
    await expect(screen.getByRole('alertdialog')).toBeHidden();
    await expect(row).toHaveCount(0);
    await expect(screen.getByRole('heading', 'Let the routine run itself', { level: 2 })).toBeVisible();
  });

  test('phone width hides the status words and keeps the primary action', async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await app.open('/automations');
    await expect(screen.getByText('Scheduler idle')).toBeVisible();
    await browser.setViewport({ width: 390, height: 844 });
    await expect(screen.getByText('Scheduler idle')).toBeHidden();
    await expect(screen.getByRole('link', 'New automation').first()).toBeVisible();
    await expect(screen.getByRole('button', 'More actions')).toBeVisible();
  });
});
