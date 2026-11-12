import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Serial: the zero-data checks must run before the mock task changes the counts.
describe('dashboard', { tags: ['dashboard'], serial: true }, () => {
  test('the workspace dashboard opens with its header and views', async ({ app, screen, browser }) => {
    await app.open('/dashboard');
    await expect(browser).toHaveURL(/\/dashboard$/);
    await expect(screen.getByRole('heading', 'Dashboard', { level: 1 })).toBeVisible();
    await expect(screen.getByText('Across your workspace · Includes subtasks', { exact: false })).toBeVisible();
    await expect(screen.getByText('Live')).toBeVisible();
    await expect(screen.getByRole('button', 'Export')).toBeVisible();
    await expect(screen.getByRole('button', 'Customize')).toBeVisible();
    const views = screen.getByRole('navigation', 'Dashboard views');
    await expect(views.getByRole('link')).toHaveText(['Overview', 'Usage & cost', 'Automations']);
    await expect(views.getByRole('link', 'Overview')).toHaveAttribute('aria-current', 'page');
  });

  test('every module renders with its counts', async ({ app, screen }) => {
    // Counts are numbers, not zeros: the server is shared with the other files' tasks. The
    // populated shapes are pinned by the "one mock task" test below.
    await app.open('/dashboard');
    await expect(screen.getByRole('heading', 'Workspace overview')).toBeVisible();
    for (const tile of ['Needs you', 'Running now', 'Completed', 'Failed outcomes', 'Queued', 'Scheduled']) {
      await expect(screen.getByRole('button', new RegExp(`^${tile}: \\d+$`))).toBeVisible();
    }
    await expect(screen.getByRole('region', 'Delivered')).toBeVisible();
    await expect(screen.getByRole('region', 'Why tasks failed')).toBeVisible();
    await expect(screen.getByRole('heading', /^Needs you · \d+$/)).toBeVisible();
    await expect(screen.getByRole('heading', 'Recent results')).toBeVisible();
    await expect(screen.getByRole('region', 'Recent results list')).toBeVisible();
    await expect(screen.getByRole('heading', 'Queue & scheduling')).toBeVisible();
    await expect(screen.getByRole('heading', 'Projects')).toBeVisible();
    // The header row and the one boot project.
    await expect(screen.getByRole('region', 'Project outcomes').getByRole('row')).toHaveCount(2);
  });

  test('timestamps read as an age with the instant behind them', async ({ app, screen }) => {
    await app.open('/dashboard');
    const updated = screen.getByText(/^Updated \S+ ago$/).first();
    await expect(updated).toBeVisible();
    await updated.hover();
    await expect(screen.getByRole('tooltip')).toBeVisible();
  });

  test('the window filter switches the outcome period', async ({ app, screen }) => {
    await app.open('/dashboard');
    const period = screen.getByRole('combobox', 'Outcomes period');
    await expect(period).toHaveText('Last 7 days');
    await expect(screen.getByText('Last 7 calendar days').first()).toBeVisible();
    await period.tap();
    await screen.getByRole('option', 'Last 30 days').tap();
    await expect(period).toHaveText('Last 30 days');
    await expect(screen.getByText('Last 30 calendar days').first()).toBeVisible();
    await expect(screen.getByText('Last 7 calendar days')).toHaveCount(0);
  });

  test('the view links switch the dashboard', async ({ app, screen, browser }) => {
    await app.open('/dashboard');
    const views = screen.getByRole('navigation', 'Dashboard views');
    await views.getByRole('link', 'Usage & cost').tap();
    await expect(browser).toHaveURL(/\/dashboard\?view=costs$/);
    await expect(views.getByRole('link', 'Usage & cost')).toHaveAttribute('aria-current', 'page');
    await views.getByRole('link', 'Automations').tap();
    await expect(browser).toHaveURL(/\/dashboard\?view=automations$/);
    await expect(screen.getByRole('heading', 'Automations').first()).toBeVisible();
  });

  test('one mock task moves the counts and the feed', async ({ app, screen }) => {
    const title = `E2E ${Date.now()} dashboard task`;
    await app.open('/new');
    await screen.getByRole('textbox', 'Describe a task for the agent').fill(title);
    await screen.getByRole('button', 'Start task').tap();
    // The bundled mock does one pass and parks waiting for a reply: a "needs you" outcome.
    await expect(screen.getByRole('image', 'needs you')).toBeVisible({ timeout: 60_000 });

    await app.open('/dashboard');
    // Counts are at least one: other files on the same server park tasks of their own.
    await expect(screen.getByRole('button', /^Needs you: [1-9]\d*$/)).toBeVisible({ timeout: 15_000 });
    await expect(screen.getByRole('heading', /^Needs you · [1-9]\d*$/)).toBeVisible();
    await expect(screen.getByText(/^[1-9]\d* questions · \d+ reviews$/)).toBeVisible();
    await expect(screen.getByRole('link', title)).toBeVisible();
    await expect(screen.getByText('All caught up — no tasks need your input')).toHaveCount(0);
    await expect(screen.getByRole('region', 'Project outcomes').getByRole('button', /: Needs you: [1-9]\d*$/)).toBeVisible();
  });

  test('phone width keeps the header and the modules', async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open('/dashboard');
    await expect(screen.getByRole('heading', 'Dashboard', { level: 1 })).toBeVisible();
    await expect(screen.getByRole('navigation', 'Dashboard views')).toBeVisible();
    await expect(screen.getByRole('combobox', 'Outcomes period')).toBeVisible();
    await expect(screen.getByRole('heading', 'Projects')).toBeVisible();
  });
});
