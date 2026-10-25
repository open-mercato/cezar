import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('deferred start radio keyboard selection and failed refresh gate submission', async ({ app, screen, browser }) => {
  let previews = 0;
  await browser.route('**/deferred-start/preview', async route => {
    previews++;
    await route.fulfill({ json: previews === 1
      ? { available: true, notBefore: '2099-01-01T09:00:00Z', timeZone: 'UTC', previewRevision: 'synthetic-preview' }
      : { available: false, reason: 'no-data', message: 'No upcoming reset in this test.' } });
  });
  await app.open('/new');
  await screen.getByRole('textbox', 'Describe a task for the agent').fill('Verify deferred start controls');
  await screen.getByRole('button', 'Choose task start time').tap();
  await expect(screen.getByRole('radio', 'After usage limit resets')).toBeEnabled();
  await screen.getByRole('radio', 'Now').tap();
  await browser.keyboard.press('ArrowDown');
  await expect(screen.getByRole('radio', 'Pick date & time')).toBeChecked();
  await browser.keyboard.press('ArrowDown');
  await expect(screen.getByRole('radio', 'After usage limit resets')).toBeChecked();
  await expect(screen.getByRole('button', 'Schedule task')).toBeDisabled();
  await screen.getByRole('button', 'Check start time').tap();
  await expect(screen.getByRole('button', 'Schedule task')).toBeEnabled();
  await screen.getByRole('button', 'Refresh preview').tap();
  await expect(screen.getByRole('alert')).toContainText('No upcoming reset');
  await expect(screen.getByRole('button', 'Schedule task')).toBeDisabled();
  await expect(screen.getByText('Earliest start:', { exact: false })).toHaveCount(0);
  await browser.keyboard.press('Escape');
  await expect(screen.getByRole('button', 'Choose task start time')).toBeFocused();
  await screen.getByRole('textbox', 'Describe a task for the agent').press('Control+Enter');
  await expect(screen.getByRole('textbox', 'Describe a task for the agent')).toHaveValue('Verify deferred start controls');
});

// Synthetic previews isolate layout from provider availability. These assertions need a
// real layout engine: DOM visibility alone passes even when the preview is clipped.
for (const theme of ['dark', 'light']) {
  for (const [width, height] of [[320, 568], [320, 400], [390, 844], [1440, 1000]]) {
    test(`start picker scrolls date and reset previews at ${width}x${height} in ${theme}`, async ({ app, screen, browser }) => {
      await browser.setViewport({ width, height });
      let failPreview = false;
      await browser.route('**/deferred-start/preview', async route => {
        await route.fulfill({ json: failPreview
          ? { available: false, reason: 'no-data', message: 'No upcoming reset in this test. Try refreshing the observed account usage before scheduling.' }
          : { available: true, notBefore: '2099-01-01T09:00:00Z', timeZone: 'Pacific/Honolulu', previewRevision: 'synthetic-preview', observation: 'Synthetic weekly reset, observed two days ago. Reset time includes the grace period and rounding to the next minute.' } });
      });
      await app.open('/new');
      await browser.evaluate(theme => {
        document.documentElement.classList.toggle('light', theme === 'light');
        document.documentElement.classList.toggle('dark', theme === 'dark');
      }, theme);
      await screen.getByRole('textbox', 'Describe a task for the agent').fill('Check small viewport scheduling');
      for (const mode of ['Pick date & time', 'After usage limit resets']) {
        failPreview = false;
        await screen.getByRole('button', 'Choose task start time').tap();
        await screen.getByRole('radio', mode).tap();
        if (mode === 'Pick date & time') {
          await screen.getByLabel('Date', { exact: true }).fill('2099-01-01');
          await screen.getByLabel('Time (server time zone)').fill('09:00');
        } else {
          await screen.getByRole('button', 'Check start time').tap();
        }
        await expect(screen.getByText('Earliest start:', { exact: false })).toHaveCount(1);
        await expect.poll(() => browser.evaluate(() => {
          const el = document.querySelector('[role="dialog"]')!;
          const box = el.getBoundingClientRect();
          return box.top >= -1 && box.bottom <= innerHeight + 1 && box.left >= 0 && box.right <= innerWidth + 1
            && el.scrollWidth <= el.clientWidth;
        })).toBe(true);
        const center = await browser.evaluate(() => {
          const el = document.querySelector('[role="dialog"]')!;
          el.scrollTop = 0;
          const box = el.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        });
        await browser.mouse.move(center.x, center.y);
        await browser.mouse.wheel(0, 1000);
        await expect.poll(() => browser.evaluate(() => {
          const el = document.querySelector('[role="dialog"]')!;
          return el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
        })).toBe(true);
        // Keyboard scrolling reaches the final explanatory paragraph, even without a
        // focusable element there. End scrolls the focused scroll container.
        await browser.evaluate(() => (document.querySelector('[role="dialog"]') as HTMLElement).focus());
        await browser.keyboard.press('Home');
        await expect.poll(() => browser.evaluate(() => document.querySelector('[role="dialog"]')!.scrollTop)).toBe(0);
        await browser.keyboard.press('End');
        await expect.poll(() => browser.evaluate(() => {
          const el = document.querySelector('[role="dialog"]')!;
          const last = el.querySelector('[role="status"] p:last-child')!.getBoundingClientRect();
          const box = el.getBoundingClientRect();
          return last.top >= box.top && last.bottom <= box.bottom + 1 && last.bottom <= innerHeight;
        })).toBe(true);
        await app.screenshot(`${theme}-${width}x${height}-${mode === 'Pick date & time' ? 'date' : 'reset'}-scrolled`);
        await browser.keyboard.press('Escape');
        await expect(screen.getByRole('button', 'Choose task start time')).toBeFocused();
        await expect.poll(() => browser.evaluate(() => {
          const el = document.querySelector('[aria-label="Choose task start time"]')!;
          const box = el.getBoundingClientRect();
          return box.left >= 0 && box.right <= innerWidth && el.scrollWidth <= el.clientWidth;
        })).toBe(true);
        if (mode === 'After usage limit resets') {
          await expect(screen.getByRole('button', 'Choose task start time')).toContainText('Dec');
          await expect(screen.getByRole('button', 'Choose task start time')).toContainText('Pacific/Honolulu');
        }
        await screen.getByRole('button', 'Choose task start time').tap();
        failPreview = true;
        if (mode === 'Pick date & time') {
          await expect(screen.getByRole('button', 'Refresh preview')).toHaveCount(0);
          await expect(screen.getByRole('button', 'Check start time')).toHaveCount(0);
          await screen.getByLabel('Time (server time zone)').fill('09:01');
        } else {
          await screen.getByRole('button', 'Refresh preview').tap();
        }
        await expect(screen.getByRole('alert')).toContainText('No upcoming reset');
        await browser.evaluate(() => (document.querySelector('[role="dialog"]') as HTMLElement).focus());
        await browser.keyboard.press('End');
        await expect.poll(() => browser.evaluate(() => {
          const box = document.querySelector('[role="alert"]')!.getBoundingClientRect();
          return box.top >= 0 && box.bottom <= innerHeight;
        })).toBe(true);
        await browser.keyboard.press('Escape');
        await expect(screen.getByRole('button', 'Choose task start time')).toBeFocused();
      }
    });
  }
}


test('date inputs check automatically and never submit incomplete wall times', async ({ app, screen, browser }) => {
  let checks = 0;
  await browser.route('**/deferred-start/preview', async route => {
    checks++;
    await route.continue();
  });
  await app.open('/new');
  await screen.getByRole('textbox', 'Describe a task for the agent').fill('Validate native date input');
  await screen.getByRole('button', 'Choose task start time').tap();
  await screen.getByRole('radio', 'Pick date & time').tap();
  await expect(screen.getByRole('button', 'Check start time')).toHaveCount(0);
  await expect(screen.getByText('Server time zone:', { exact: false })).toHaveCount(1);
  await expect(screen.getByRole('alert')).toHaveCount(0);
  await screen.getByLabel('Time (server time zone)').fill('');
  await screen.getByLabel('Date', { exact: true }).fill('2099-10-14');
  await expect(screen.getByRole('alert')).toContainText('Enter a complete time.');
  // Wait beyond the debounce to prove no invalid request was sent.
  await browser.evaluate(() => new Promise(resolve => setTimeout(resolve, 800)));
  expect(checks).toBe(0);
  await expect(screen.getByLabel('Time (server time zone)')).toHaveValue('');
  await screen.getByLabel('Time (server time zone)').fill('22:00');
  await expect(screen.getByText('Earliest start:', { exact: false })).toHaveCount(1);
  expect(checks).toBe(1);
  await expect(screen.getByRole('button', 'Refresh preview')).toHaveCount(0);
  await screen.getByLabel('Date', { exact: true }).fill('2000-01-01');
  await expect(screen.getByRole('alert')).toContainText('Choose a future date and time.');
  await expect(screen.getByText('Earliest start:', { exact: false })).toHaveCount(0);
  await browser.evaluate(() => new Promise(resolve => setTimeout(resolve, 800)));
  expect(checks).toBe(1);
  await screen.getByLabel('Date', { exact: true }).fill('');
  await expect(screen.getByRole('alert')).toContainText('Pick a date');
  await app.screenshot('date-input-incomplete');
});

test('date unavailable retry and definite rejection preserve deferred intent', async ({ app, screen, browser }) => {
  let previews = 0;
  let immediate = 0;
  await browser.route('**/deferred-start/preview', async route => {
    await route.fulfill({ json: ++previews === 1
      ? { available: false, reason: 'account-unverifiable', message: 'The signed-in Codex account cannot be checked right now. Retry the preview.' }
      : { available: true, notBefore: '2099-01-01T09:00:00Z', timeZone: 'UTC', previewRevision: 'synthetic-preview' } });
  });
  await browser.route('**/deferred-start', route => route.fulfill({ status: 400, json: { error: 'Choose a future date and time in the server time zone.' } }));
  await browser.route('**/runs', async route => {
    if (route.request.method === 'POST') { immediate++; await route.fulfill({ status: 500, json: { error: 'Unexpected immediate creation' } }); }
    else await route.continue();
  });
  await app.open('/new');
  const prompt = screen.getByRole('textbox', 'Describe a task for the agent');
  await prompt.fill('Retain this deferred task');
  await screen.getByRole('button', 'Choose task start time').tap();
  await screen.getByRole('radio', 'Pick date & time').tap();
  await screen.getByLabel('Date', { exact: true }).fill('2099-01-01');
  await screen.getByRole('button', 'Retry').tap();
  await expect(screen.getByRole('button', 'Schedule task')).toBeEnabled();
  await expect(screen.getByRole('button', 'Check start time')).toHaveCount(0);
  await browser.keyboard.press('Escape');
  await screen.getByRole('button', 'Schedule task').tap();
  await expect(prompt).toHaveValue('Retain this deferred task');
  await expect(screen.getByRole('button', 'Schedule task')).toBeDisabled();
  await prompt.press('Control+Enter');
  expect(immediate).toBe(0);
  await screen.getByRole('button', 'Choose task start time').tap();
  await expect(screen.getByRole('radio', 'Pick date & time')).toBeChecked();
  await expect(screen.getByLabel('Date', { exact: true })).toHaveValue('2099-01-01');
  await expect(screen.getByText('Earliest start:', { exact: false })).toHaveCount(0);
  await screen.getByRole('radio', 'Now').tap();
  await expect(screen.getByRole('button', 'Start task')).toBeEnabled();
});

test('preview expiry disables scheduling while the picker is closed', async ({ app, screen, browser }) => {
  await browser.route('**/deferred-start/preview', route => route.fulfill({ json: {
    available: true, notBefore: new Date(Date.now() + 2000).toISOString(),
    timeZone: 'UTC', previewRevision: 'synthetic-expiring-preview',
  } }));
  await app.open('/new');
  await screen.getByRole('textbox', 'Describe a task for the agent').fill('Keep deferred intent after expiry');
  await screen.getByRole('button', 'Choose task start time').tap();
  await screen.getByRole('radio', 'Pick date & time').tap();
  await screen.getByLabel('Date', { exact: true }).fill('2099-01-01');
  await expect(screen.getByRole('button', 'Schedule task')).toBeEnabled();
  await browser.keyboard.press('Escape');
  await expect(screen.getByRole('button', 'Schedule task')).toBeDisabled();
  await screen.getByRole('button', 'Choose task start time').tap();
  await expect(screen.getByRole('radio', 'Pick date & time')).toBeChecked();
  await expect(screen.getByRole('alert')).toContainText('has passed');
  await expect(screen.getByText('Earliest start:', { exact: false })).toHaveCount(0);
});
