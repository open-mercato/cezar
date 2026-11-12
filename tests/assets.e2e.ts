import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Serial: the empty state must be seen before the mock task writes its demo asset.
describe('assets', { tags: ['assets'], serial: true }, () => {
  test('the page opens empty with its explanation', async ({ app, screen, browser }) => {
    await app.open('/assets');
    await expect(browser).toHaveURL(/\/p\/[^/]+\/assets$/);
    await expect(screen.getByRole('heading', 'Assets', { level: 1 })).toBeVisible();
    await expect(screen.getByText('Every page and report your agents wrote, newest first.')).toBeVisible();
    await expect(screen.getByRole('heading', 'No assets yet')).toBeVisible();
    await expect(
      screen.getByText("When an agent writes a page or report into its artifacts folder, it shows up here and in its task's Assets tab."),
    ).toBeVisible();
    await expect(screen.getByRole('table')).toHaveCount(0);
  });

  test('phone width drops the desktop header and keeps the empty state', async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open('/assets');
    await expect(screen.getByRole('heading', 'No assets yet')).toBeVisible();
    await expect(screen.getByText('Every page and report your agents wrote, newest first.')).toBeHidden();
  });

  test('a mock task’s report shows up in the table, filters, and stacks on a phone', async ({ app, screen, browser }) => {
    // The serial group shares the browser: undo the phone viewport of the test before.
    await browser.setViewport({ width: 1280, height: 720 });
    const title = `E2E ${Date.now()} asset`;
    await app.open('/new');
    await screen.getByRole('textbox', 'Describe a task for the agent').fill(title);
    await screen.getByRole('button', 'Start task').tap();
    // The bundled mock writes `demo.html` then parks waiting for a reply.
    await expect(screen.getByRole('image', 'needs you')).toBeVisible({ timeout: 60_000 });

    await app.open('/assets');
    await expect(screen.getByRole('heading', 'No assets yet')).toHaveCount(0);
    await expect(screen.getByRole('group', 'Filter assets')).toBeVisible();
    const table = screen.getByRole('table');
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveText(['Asset', 'Subject', 'State', 'Version', 'Updated'], { ignoreCase: true });
    const row = table.getByRole('row').filter({ hasText: title });
    await expect(row).toBeVisible();
    await expect(row.getByRole('link', 'Dry-run demo report')).toBeVisible();
    await expect(row).toContainText('v1');

    await screen.getByRole('button', 'Markdown').tap();
    await expect(screen.getByText('No markdown assets.')).toBeVisible();
    await screen.getByRole('button', 'HTML').tap();
    await expect(row).toBeVisible();

    await browser.setViewport({ width: 390, height: 844 });
    await expect(table).toBeHidden();
    await expect(screen.getByRole('listitem').filter({ hasText: title }).getByRole('link', 'Dry-run demo report')).toBeVisible();
  });
});
