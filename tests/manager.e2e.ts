import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Screen } from 'e2e';

/** `/manager/new` → the chat of a run-unique manager; its name is the prompt's first line. */
async function createManager(screen: Screen, browser: { waitForURL(url: RegExp): Promise<unknown> }, name: string) {
  await screen.getByLabel('What should this manager do?').fill(`${name}\nWatch the e2e fixture repository and report what needs me.`);
  await screen.getByRole('button', 'Create manager').tap();
  await browser.waitForURL(/\/manager\/[^/?#]+$/);
  await expect(screen.getByRole('heading', name, { level: 1 })).toBeVisible();
}

describe('manager', { tags: ['manager'] }, () => {
  test('managers are enabled: /manager answers and the sidebar offers the mode', async ({ app, browser }) => {
    const health = await fetch(new URL('/api/v1/health', app.baseUrl));
    expect(await health.json()).toMatchObject({ capabilities: { managers: true } });
    await app.open('/manager');
    // Nothing redirected the gate home: the URL stays in the manager area, on the setup form
    // (no managers yet) or the most recent chat (a parallel test made one).
    await expect(browser).toHaveURL(/\/manager(\/[^/?#]+)?$/);
    await expect(browser.locator('[data-route="manager-new"], [data-slot="manager-transcript"]').first()).toBeVisible();
  });

  test('the setup form: heading, mascot picker, presets fill the prompt', async ({ app, screen, browser }) => {
    await app.open('/manager/new');
    await expect(browser).toHaveURL(/\/manager\/new$/);
    await expect(screen.getByRole('heading', /^(Set up your first manager|New manager)$/, { level: 1 })).toBeVisible();

    const prompt = screen.getByLabel('What should this manager do?');
    await expect(prompt).toBeVisible();
    await expect(screen.getByRole('button', 'Create manager')).toBeVisible();
    await expect(screen.getByRole('radio', 'Scout', { exact: true })).toBeVisible();

    await screen.getByRole('button', 'Watch my repositories').tap();
    await expect(prompt).toHaveValue(/^Watch my repositories and tell me/);
    await screen.getByRole('button', 'Keep PRs moving').tap();
    await expect(prompt).toHaveValue(/^Keep an eye on open pull requests/);
  });

  test('the ManagerHeader leads back to the tasks page this tab left', async ({ app, screen, browser }) => {
    // `/tasks` is the workspace-wide All tasks page; the shell records it as the way back.
    await app.open('/tasks');
    await expect(browser).toHaveURL(/\/tasks$/);
    await expect(screen.getByRole('navigation', 'Main')).toBeVisible();
    // The header strip exists only while the sidebar is the icon rail (the fold persists per browser).
    await screen.getByRole('button', 'Hide sidebar').tap();
    await expect(screen.getByRole('button', 'Hide sidebar')).toBeHidden();

    // In-app, as a user would: the remembered page lives in this tab's sessionStorage.
    await screen.getByRole('link', 'Manager', { visible: true }).tap();
    await expect(browser).toHaveURL(/\/manager(\/[^/?#]+)?$/);
    const header = browser.locator('[data-slot="manager-header"]');
    await expect(header).toBeVisible();
    await expect(header).toContainText('Manager');
    const back = screen.getByRole('link', /^Back to /);
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute('href', '/tasks');
    await back.tap();
    await expect(browser).toHaveURL(/\/tasks$/);
    await expect(screen.getByRole('link', /^Back to /)).toBeHidden();
  });

  test('a new manager chats with the mock agent: the message lands and a reply streams', async ({ app, screen, browser }) => {
    const name = `E2E ${Date.now()} chat`;
    await app.open('/manager/new');
    await createManager(screen, browser, name);

    const transcript = screen.getByRole('region', `Conversation with ${name}`);
    await expect(transcript).toBeVisible();
    await expect(browser.locator('[data-slot="manager-user"]').first()).toContainText(name);
    await expect(browser.locator('[data-slot="manager-assistant"]').first()).toBeVisible({ timeout: 60_000 });
    // The streaming reply settles: the Working status leaves the footer.
    await expect(browser.locator('[data-slot="manager-working"]')).toHaveCount(0, { timeout: 60_000 });

    const question = `Second message ${Date.now()}`;
    await screen.getByLabel(`Message ${name}`).fill(question);
    await screen.getByRole('button', 'Send').tap();
    await expect(browser.locator('[data-slot="manager-user"]')).toHaveCount(2);
    await expect(browser.locator('[data-slot="manager-user"]').last()).toContainText(question);
    await expect(browser.locator('[data-slot="manager-assistant"]')).toHaveCount(2, { timeout: 60_000 });
    await expect(browser.locator('[data-slot="manager-working"]')).toHaveCount(0, { timeout: 60_000 });

    // The chat is the manager's URL: a reload lands on the same transcript.
    await browser.reload();
    await expect(screen.getByRole('heading', name, { level: 1 })).toBeVisible();
    await expect(browser.locator('[data-slot="manager-user"]')).toHaveCount(2);
  });

  test('the manager rail lists the manager and ?all=1 is the list screen', async ({ app, screen, browser }) => {
    const name = `E2E ${Date.now()} listed`;
    await app.open('/manager/new');
    await createManager(screen, browser, name);
    const chatUrl = new URL(await browser.url()).pathname;

    await app.open('/manager?all=1');
    const list = browser.locator('[data-route="manager-list"]');
    await expect(list).toBeVisible();
    await expect(list.getByRole('link', 'New manager')).toBeVisible();
    await list.getByRole('link', { name: name, exact: false }).tap();
    await expect(browser).toHaveURL(chatUrl);
  });

  test('manager settings: the job interval stepper holds 5…10080 and a job saves', async ({ app, screen, browser }) => {
    const name = `E2E ${Date.now()} jobs`;
    await app.open('/manager/new');
    await createManager(screen, browser, name);

    await screen.getByRole('button', 'Manager settings').tap();
    const menu = browser.locator('[data-slot="manager-settings-menu"]');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('switch', 'Notify me when important')).toBeVisible();
    await menu.getByRole('button', 'Jobs…').tap();

    const dialog = screen.getByRole('dialog');
    await expect(dialog.getByRole('heading', 'Jobs')).toBeVisible();
    await expect(dialog.getByText('No jobs yet.')).toBeVisible();
    await dialog.getByRole('button', 'Add job').tap();

    const interval = dialog.getByRole('spinbutton', 'Job interval in minutes');
    await expect(interval).toHaveValue('60');
    await expect(interval).toHaveAttribute('aria-valuemin', '5');
    await expect(interval).toHaveAttribute('aria-valuemax', '10080');
    const save = dialog.getByRole('button', 'Save jobs');
    // A nameless, promptless job cannot be saved.
    await expect(save).toBeDisabled();

    await interval.fill('3');
    await expect(interval).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByText('Enter a whole number from 5 to 10080.')).toBeVisible();
    await interval.fill('5');
    await interval.press('Enter');
    await expect(interval).toHaveValue('5');
    await expect(dialog.getByRole('button', 'Decrease Job interval in minutes')).toBeDisabled();
    await dialog.getByRole('button', 'Increase Job interval in minutes').tap();
    await expect(interval).toHaveValue('6');
    await interval.fill('10080');
    await interval.press('Enter');
    await expect(dialog.getByRole('button', 'Increase Job interval in minutes')).toBeDisabled();
    await interval.fill('10081');
    await expect(dialog.getByText('Enter a whole number from 5 to 10080.')).toBeVisible();
    // Not Escape: the dialog takes it too and drops the draft job (see the report).
    await interval.fill('10080');
    await interval.press('Enter');
    await expect(interval).toHaveValue('10080');

    await dialog.getByLabel('Job name').fill('Nightly sweep');
    await dialog.getByLabel('Job prompt').fill('Summarize what changed since the last check.');
    await expect(save).toBeEnabled();
    await save.tap();
    await expect(screen.getByRole('dialog')).toBeHidden();

    // The gear counts the saved job; reopening shows the interval it kept.
    await screen.getByRole('button', 'Manager settings').tap();
    await menu.getByRole('button', 'Jobs (1)…').tap();
    await expect(screen.getByRole('dialog').getByRole('spinbutton', 'Job interval in minutes')).toHaveValue('10080');
    await expect(screen.getByRole('dialog').getByLabel('Job name')).toHaveValue('Nightly sweep');
    await screen.getByRole('dialog').getByRole('button', 'Cancel').tap();
    await expect(screen.getByRole('dialog')).toBeHidden();
  });

  test('Delete asks first and Cancel keeps the manager', async ({ app, screen, browser }) => {
    const name = `E2E ${Date.now()} keep`;
    await app.open('/manager/new');
    await createManager(screen, browser, name);

    await screen.getByRole('button', 'Manager settings').tap();
    await browser.locator('[data-slot="manager-settings-menu"]').getByRole('button', 'Delete…').tap();
    const dialog = screen.getByRole('alertdialog');
    await expect(dialog.getByRole('heading', `Delete ${name}?`)).toBeVisible();
    await expect(dialog.getByRole('button', 'Delete')).toBeVisible();
    await dialog.getByRole('button', 'Cancel').tap();
    await expect(screen.getByRole('alertdialog')).toBeHidden();
    await expect(screen.getByRole('heading', name, { level: 1 })).toBeVisible();
  });

  test('phone: the manager chat keeps its composer and the mobile bar says Manager', async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    const name = `E2E ${Date.now()} phone`;
    await app.open('/manager/new');
    await createManager(screen, browser, name);
    // Desktop-only strip: the mobile top bar titles the page instead.
    await expect(browser.locator('[data-slot="manager-header"]')).toBeHidden();
    await expect(screen.getByLabel(`Message ${name}`)).toBeVisible();
    await expect(screen.getByRole('button', 'Manager settings')).toBeVisible();
  });
});
