import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';

/**
 * Deferred start on the new composer (design Proposal 5): the picker is the "Start" row of the
 * Options panel — "Options ⌄" → "Choose task start time" — and checks itself after a debounce
 * instead of behind a "Check start time" button. Previews are stubbed so the assertions never
 * depend on a provider's reset data; the options request stays real.
 */

const PROMPT = 'Describe a task for the agent';
const START_CHIP = 'Choose task start time';

/** The preview a stub answers with for 2099-01-01 09:00 UTC. */
const PREVIEW_OK = { available: true, notBefore: '2099-01-01T09:00:00Z', timeZone: 'UTC', previewRevision: 'synthetic-preview' };

type Screen = Parameters<Parameters<typeof test>[1]>[0]['screen'];

/** The Options panel is where the picker lives now; both are popovers, so both are dialogs. */
async function openPicker(screen: Screen) {
  await screen.getByRole('button', 'Options').tap();
  await screen.getByRole('dialog', 'Options').getByRole('button', START_CHIP).tap();
  await expect(screen.getByRole('radio', 'Now')).toBeVisible();
}

/** Escape from a radio closes the picker (a native date input eats its own Escape), then
 *  Escape from the chip closes the panel. */
async function closePicker(screen: Screen) {
  await screen.getByRole('radio', 'Now').press('Escape');
  await expect(screen.getByRole('radio', 'Now')).toBeHidden();
  await expect(screen.getByRole('button', START_CHIP)).toBeFocused();
  await screen.getByRole('button', START_CHIP).press('Escape');
  await expect(screen.getByRole('dialog', 'Options')).toBeHidden();
}

describe('deferred start', { tags: ['deferred-start'] }, () => {
  test('radio keyboard selection, and a failed refresh gates submission', async ({ app, screen, browser }) => {
    let resetPreviews = 0;
    await browser.route('**/deferred-start/preview', async (route) => {
      const start = (JSON.parse(route.request.postData ?? '{}') as { start?: { kind?: string } }).start?.kind;
      // The date radio is passed through on the way to the reset one: only reset checks count.
      if (start !== 'usage-reset') return route.fulfill({ json: PREVIEW_OK });
      resetPreviews += 1;
      await route.fulfill({ json: resetPreviews === 1
        ? PREVIEW_OK
        : { available: false, reason: 'no-data', message: 'No upcoming reset in this test.' } });
    });
    await app.open('/new');
    const prompt = screen.getByRole('textbox', PROMPT);
    await prompt.fill('Verify deferred start controls');
    await openPicker(screen);
    await expect(screen.getByRole('radio', 'After usage limit resets')).toBeEnabled({ timeout: 15_000 });
    await screen.getByRole('radio', 'Now').tap();
    await browser.keyboard.press('ArrowDown');
    await expect(screen.getByRole('radio', 'Pick date & time')).toBeChecked();
    await browser.keyboard.press('ArrowDown');
    await expect(screen.getByRole('radio', 'After usage limit resets')).toBeChecked();
    // The send button turns into Schedule task and waits for the (automatic) check.
    const schedule = screen.getByRole('button', 'Schedule task');
    await expect(schedule).toBeEnabled({ timeout: 10_000 });
    await expect(screen.getByText('Earliest start:', { exact: false })).toHaveCount(1);
    await screen.getByRole('button', 'Refresh').tap();
    await expect(screen.getByRole('alert')).toContainText('No upcoming reset');
    await expect(schedule).toBeDisabled();
    await expect(screen.getByText('Earliest start:', { exact: false })).toHaveCount(0);
    expect(resetPreviews).toBe(2);
    // Escape closes the picker only: focus lands back on its chip inside the still-open panel.
    await browser.keyboard.press('Escape');
    await expect(screen.getByRole('button', START_CHIP)).toBeFocused();
    await expect(screen.getByRole('dialog', 'Options')).toBeVisible();
    await browser.keyboard.press('Escape');
    await expect(screen.getByRole('dialog', 'Options')).toBeHidden();
    // A blocked schedule does not submit from the keyboard either.
    await prompt.press('Control+Enter');
    await expect(prompt).toHaveValue('Verify deferred start controls');
    await expect(schedule).toBeDisabled();
  });

  test('date inputs check automatically and never submit incomplete wall times', async ({ app, screen, browser }) => {
    let checks = 0;
    await browser.route('**/deferred-start/preview', async (route) => {
      checks += 1;
      await route.continue();
    });
    await app.open('/new');
    await screen.getByRole('textbox', PROMPT).fill('Validate native date input');
    await openPicker(screen);
    await screen.getByRole('radio', 'Pick date & time').tap();
    await expect(screen.getByText('Server time zone:', { exact: false })).toHaveCount(1, { timeout: 15_000 });
    await expect(screen.getByRole('alert')).toHaveCount(0);
    const date = screen.getByLabel('Date', { exact: true });
    const time = screen.getByLabel('Time (server time zone)');
    await time.fill('');
    await date.fill('2099-10-14');
    await expect(screen.getByRole('alert')).toContainText('Enter a complete time.');
    await expect(time).toHaveValue('');
    await time.fill('22:00');
    await expect(screen.getByText('Earliest start:', { exact: false })).toHaveCount(1, { timeout: 15_000 });
    // The complete time was the FIRST request: the incomplete one never went out.
    expect(checks).toBe(1);
    await expect(screen.getByRole('button', 'Retry')).toHaveCount(0);
    await date.fill('2000-01-01');
    await expect(screen.getByRole('alert')).toContainText('Choose a future date and time.');
    await expect(screen.getByText('Earliest start:', { exact: false })).toHaveCount(0);
    await date.fill('');
    await expect(screen.getByRole('alert')).toContainText('Pick a date');
    expect(checks).toBe(1);
  });

  test('an unverifiable preview retries, and a definite rejection keeps the deferred intent', async ({ app, screen, browser }) => {
    let previews = 0;
    let immediate = 0;
    await browser.route('**/deferred-start/preview', async (route) => {
      await route.fulfill({ json: ++previews === 1
        ? { available: false, reason: 'account-unverifiable', message: 'The signed-in Codex account cannot be checked right now. Retry the preview.' }
        : PREVIEW_OK });
    });
    await browser.route('**/deferred-start', (route) => route.fulfill({ status: 400, json: { error: 'Choose a future date and time in the server time zone.' } }));
    await browser.route('**/runs', async (route) => {
      if (route.request.method === 'POST') {
        immediate += 1;
        await route.fulfill({ status: 500, json: { error: 'Unexpected immediate creation' } });
      } else await route.continue();
    });
    await app.open('/new');
    const prompt = screen.getByRole('textbox', PROMPT);
    await prompt.fill('Retain this deferred task');
    await openPicker(screen);
    await screen.getByRole('radio', 'Pick date & time').tap();
    await screen.getByLabel('Date', { exact: true }).fill('2099-01-01');
    await expect(screen.getByRole('alert')).toContainText('cannot be checked', { timeout: 10_000 });
    await screen.getByRole('button', 'Retry').tap();
    const schedule = screen.getByRole('button', 'Schedule task');
    await expect(schedule).toBeEnabled({ timeout: 10_000 });
    await closePicker(screen);
    await schedule.tap();
    // Rejected for good: the prompt stays, scheduling is blocked, and nothing starts now.
    await expect(prompt).toHaveValue('Retain this deferred task');
    await expect(schedule).toBeDisabled();
    await prompt.press('Control+Enter');
    expect(immediate).toBe(0);
    await openPicker(screen);
    await expect(screen.getByRole('radio', 'Pick date & time')).toBeChecked();
    await expect(screen.getByLabel('Date', { exact: true })).toHaveValue('2099-01-01');
    await expect(screen.getByRole('alert')).toContainText('Choose a future date and time in the server time zone.');
    await expect(screen.getByText('Earliest start:', { exact: false })).toHaveCount(0);
    await screen.getByRole('radio', 'Now').tap();
    await expect(screen.getByRole('button', 'Start task')).toBeEnabled();
    expect(immediate).toBe(0);
  });

  test('a preview that expires while the picker is closed disables scheduling', async ({ app, screen, browser }) => {
    await browser.route('**/deferred-start/preview', (route) => route.fulfill({ json: {
      available: true, notBefore: new Date(Date.now() + 2000).toISOString(),
      timeZone: 'UTC', previewRevision: 'synthetic-expiring-preview',
    } }));
    await app.open('/new');
    await screen.getByRole('textbox', PROMPT).fill('Keep deferred intent after expiry');
    await openPicker(screen);
    await screen.getByRole('radio', 'Pick date & time').tap();
    await screen.getByLabel('Date', { exact: true }).fill('2099-01-01');
    const schedule = screen.getByRole('button', 'Schedule task');
    await expect(schedule).toBeEnabled({ timeout: 10_000 });
    await closePicker(screen);
    await expect(schedule).toBeDisabled({ timeout: 10_000 });
    await openPicker(screen);
    await expect(screen.getByRole('radio', 'Pick date & time')).toBeChecked();
    await expect(screen.getByRole('alert')).toContainText('has passed');
    await expect(screen.getByText('Earliest start:', { exact: false })).toHaveCount(0);
  });

  test('the chosen start is summarised beside Send and reopens the picker', async ({ app, screen, browser }) => {
    await browser.route('**/deferred-start/preview', (route) => route.fulfill({ json: PREVIEW_OK }));
    await app.open('/new');
    await screen.getByRole('textbox', PROMPT).fill('Summarise the schedule');
    await openPicker(screen);
    await screen.getByRole('radio', 'Pick date & time').tap();
    await screen.getByLabel('Date', { exact: true }).fill('2099-01-01');
    await expect(screen.getByRole('button', 'Schedule task')).toBeEnabled({ timeout: 10_000 });
    await closePicker(screen);
    const summary = browser.locator('[data-slot="schedule-summary"]');
    await expect(summary).toContainText('2099');
    await summary.tap();
    await expect(screen.getByRole('dialog', 'Options')).toBeVisible();
    await expect(screen.getByRole('radio', 'Pick date & time')).toBeChecked();
  });

  test('at phone width the picker stays inside the viewport', async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await browser.route('**/deferred-start/preview', (route) => route.fulfill({ json: PREVIEW_OK }));
    await app.open('/new');
    await screen.getByRole('textbox', PROMPT).fill('Phone width scheduling');
    await openPicker(screen);
    await screen.getByRole('radio', 'Pick date & time').tap();
    await expect(screen.getByText('Earliest start:', { exact: false })).toHaveCount(1, { timeout: 15_000 });
    const box = await screen.getByRole('group', 'Start task').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  });
});
