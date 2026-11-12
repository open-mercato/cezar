import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';

describe('workflows', { tags: ['workflows'] }, () => {
  test('/workflows opens a new canvas with the default chain', async ({ app, screen, browser }) => {
    await app.open('/workflows');
    await expect(browser).toHaveURL(/\/p\/[^/]+\/workflows$/);
    await expect(screen.getByRole('combobox', 'Open workflow')).toHaveText('New workflow');
    await expect(screen.getByRole('textbox', 'Workflow name')).toHaveValue('');
    await expect(screen.getByRole('button', 'Save')).toBeDisabled();
    await expect(screen.getByRole('button', 'Add node')).toBeVisible();
    await expect(screen.getByRole('button', 'Simulate')).toBeVisible();
    await expect(screen.getByRole('button', 'More actions')).toBeVisible();
    await expect(screen.getByRole('application')).toBeVisible();
    await expect(screen.getByText('start')).toBeVisible();
    await expect(screen.getByText('Do the task')).toBeVisible();
    await expect(screen.getByText('end')).toBeVisible();
  });

  test('the Open workflow select lists the built-in quick-task', async ({ app, screen, browser }) => {
    await app.open('/workflows');
    await screen.getByRole('combobox', 'Open workflow').tap();
    await expect(screen.getByRole('listbox')).toBeVisible();
    await expect(screen.getByText('Built-in templates')).toBeVisible();
    await expect(screen.getByRole('option', 'implement-and-verify')).toBeVisible();
    await screen.getByRole('option', 'quick-task').tap();
    await expect(browser).toHaveURL(/\/p\/[^/]+\/workflows\/quick-task$/);
  });

  test('/workflows/quick-task shows its steps and opens as a copy', async ({ app, screen }) => {
    await app.open('/workflows/quick-task');
    await expect(screen.getByRole('combobox', 'Open workflow')).toHaveText('quick-task');
    // A built-in is a template: the canvas saves as your own copy unless renamed back.
    await expect(screen.getByRole('textbox', 'Workflow name')).toHaveValue('quick-task-copy');
    await expect(screen.getByText('start')).toBeVisible();
    await expect(screen.getByText('Do the task')).toBeVisible();
    await expect(screen.getByText('agent')).toBeVisible();
    await expect(screen.getByText('end')).toBeVisible();
    await expect(screen.getByRole('button', 'valid')).toBeVisible();
  });

  test('simulate walks the chain to its end', async ({ app, screen }) => {
    await app.open('/workflows/quick-task');
    await screen.getByRole('button', 'Simulate').tap();
    await expect(screen.getByRole('button', 'Stop')).toBeVisible();
    await expect(screen.getByText('ends with', { exact: false })).toBeVisible();
    await screen.getByRole('button', 'done').tap();
    await expect(screen.getByText('Run ends', { exact: false })).toBeVisible();
    await expect(screen.getByRole('button', 'Restart')).toBeVisible();
    await screen.getByRole('button', 'Stop').tap();
    await expect(screen.getByRole('button', 'Simulate')).toBeVisible();
  });

  test('the built-in cannot be deleted and warns before being shadowed', async ({ app, screen }) => {
    await app.open('/workflows/quick-task');
    await screen.getByRole('button', 'More actions').tap();
    await screen.getByRole('menuitem', 'Workflow settings').tap();
    await expect(screen.getByRole('complementary', 'Workflow settings')).toBeVisible();
    await expect(screen.getByRole('button', 'Delete workflow')).toHaveCount(0);
    await screen.getByRole('button', 'Close workflow settings').tap();

    await screen.getByRole('textbox', 'Workflow name').fill('quick-task');
    await screen.getByRole('button', 'Save').tap();
    const dialog = screen.getByRole('alertdialog');
    await expect(dialog.getByRole('heading', 'Replace the built-in “quick-task”?')).toBeVisible();
    await dialog.getByRole('button', 'Keep editing').tap();
    await expect(dialog).toBeHidden();
    await expect(screen.getByRole('combobox', 'Open workflow')).toHaveText('quick-task');
  });

  describe('lifecycle', { serial: true }, () => {
    const name = `e2e-wf-${Date.now()}`;

    test('a new workflow is saved under its name', async ({ app, screen, browser }) => {
      await app.open('/workflows');
      await screen.getByRole('textbox', 'Workflow name').fill(name);
      await expect(screen.getByRole('button', 'Save')).toBeEnabled();
      await screen.getByRole('button', 'Save').tap();
      await expect(screen.getByRole('status').filter({ hasText: `Saved ${name}` })).toBeVisible();
      await expect(browser).toHaveURL(new RegExp(`/p/[^/]+/workflows/${name}$`));
      await expect(screen.getByRole('combobox', 'Open workflow')).toHaveText(name);
    });

    test('the saved workflow is listed under This repo', async ({ app, screen }) => {
      await app.open('/workflows');
      await screen.getByRole('combobox', 'Open workflow').tap();
      await expect(screen.getByText('This repo')).toBeVisible();
      await expect(screen.getByRole('option', name)).toBeVisible();
      await screen.getByRole('listbox').press('Escape');
    });

    test('delete confirms, removes the file and returns to a new canvas', async ({ app, screen, browser }) => {
      await app.open(`/workflows/${name}`);
      await expect(screen.getByRole('combobox', 'Open workflow')).toHaveText(name);
      await screen.getByRole('button', 'More actions').tap();
      await screen.getByRole('menuitem', 'Workflow settings').tap();
      await screen.getByRole('button', 'Delete workflow').tap();
      const dialog = screen.getByRole('alertdialog');
      await expect(dialog.getByRole('heading', `Delete “${name}”?`)).toBeVisible();
      await dialog.getByRole('button', 'Delete').tap();
      await expect(screen.getByRole('status').filter({ hasText: `Deleted “${name}”.` })).toBeVisible();
      await expect(browser).toHaveURL(/\/p\/[^/]+\/workflows$/);
      await screen.getByRole('combobox', 'Open workflow').tap();
      await expect(screen.getByRole('option', 'quick-task')).toBeVisible();
      await expect(screen.getByRole('option', name)).toHaveCount(0);
    });
  });

  test('phone width keeps the toolbar and the canvas', async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open('/workflows/quick-task');
    await expect(screen.getByRole('combobox', 'Open workflow')).toBeVisible();
    await expect(screen.getByRole('button', 'Save')).toBeVisible();
    await expect(screen.getByRole('application')).toBeVisible();
  });
});
