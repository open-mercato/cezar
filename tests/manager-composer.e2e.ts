import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { managerSummarySchema } from '@open-mercato/cezar-contract';

test('Manager composer keeps its controls inside the prompt surface at every width without dictation', { trace: 'on', timeout: 120_000 }, async ({ app, screen, browser }) => {
  const base = app.baseUrl;
  if (!base) throw new Error('The cockpit URL is required');
  const response = await fetch(new URL('/api/v1/workspace/managers', base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Composer layout', instructions: '', projects: 'all', runner: 'codex', taskRunner: 'antigravity', cronMinutes: 0, followUp: false }),
  });
  if (!response.ok) throw new Error(`Create manager: ${response.status} ${await response.text()}`);
  const manager = managerSummarySchema.parse(await response.json());
  await browser.addInitScript(() => {
    // Exercise the explicit Manager opt-out in a browser that supports speech.
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: class {} });
  });
  const screenshot = async (label: string) => {
    const path = await app.screenshot(label);
    if (process.env.CEZ_ARTIFACTS_DIR) {
      mkdirSync(process.env.CEZ_ARTIFACTS_DIR, { recursive: true });
      copyFileSync(path, join(process.env.CEZ_ARTIFACTS_DIR, `${label}.png`));
    }
  };
  try {
    for (const size of [{ width: 1440, height: 960 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 740 }, { width: 844, height: 390 }]) {
      await browser.setViewport(size);
      await app.open(`/manager/${manager.id}`);
      const field = screen.getByRole('textbox', `Message ${manager.name}`);
      await expect(field).toHaveAttribute('placeholder', `Message ${manager.name}, or / for commands`);
      await expect(screen.getByRole('button', 'Send', { exact: true })).toBeDisabled();
      await expect(screen.getByRole('button', 'Start dictation')).toHaveCount(0);
      await expect.poll(() => browser.evaluate(() => {
        const surface = document.querySelector('[data-slot="composer"]');
        const field = surface?.querySelector('textarea');
        const toolbar = surface?.querySelector('[data-slot="composer-controls"]');
        if (!surface || !field || !toolbar) return false;
        const surfaceRect = surface.getBoundingClientRect();
        const fieldRect = field.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        const buttons = [...toolbar.querySelectorAll('button')].filter((el) => el.getClientRects().length > 0);
        return fieldRect.bottom <= toolbarRect.top && surfaceRect.bottom <= innerHeight
          && surfaceRect.left >= 0 && surfaceRect.right <= innerWidth
          && ['Attach files', 'Model and effort', 'Agent for new tasks', 'Options', 'Send'].every((name) => buttons.some((el) => el.getAttribute('aria-label') === name))
          && buttons.every((el) => {
            const rect = el.getBoundingClientRect();
            return rect.left >= surfaceRect.left && rect.right <= surfaceRect.right && rect.bottom <= surfaceRect.bottom;
          }) && document.documentElement.scrollWidth <= innerWidth;
      })).toBe(true);
      await screenshot(`manager-composer-${size.width}x${size.height}`);
      await field.fill('Keep the Manager wording and behavior');
      await expect(screen.getByRole('button', 'Send', { exact: true })).toBeEnabled();
      await screen.getByRole('button', 'Options', { exact: true }).tap();
      await expect(screen.getByRole('button', 'Agent account')).toBeVisible();
      await expect(screen.getByRole('combobox', 'Dictation language')).toHaveCount(0);
      await browser.evaluate(async () => {
        const panel = document.querySelector('[data-slot="composer-options"]');
        await Promise.all(panel?.getAnimations({ subtree: true }).map((animation) => animation.finished) ?? []);
      });
      await screenshot(`manager-options-${size.width}x${size.height}`);
      await browser.keyboard.press('Escape');
      await expect(field).toHaveValue('Keep the Manager wording and behavior');
      await screen.getByRole('button', 'Agent for new tasks').tap();
      await expect(screen.getByRole('menuitemcheckbox', 'antigravity · Automatic account')).toHaveAttribute('aria-checked', 'true');
      await browser.keyboard.press('Escape');
      await screen.getByRole('button', 'Model and effort').tap();
      await expect(screen.getByRole('menuitemradio', 'pi', { exact: true })).toHaveCount(0);
      await expect(screen.getByRole('menuitemradio', 'Use workspace default (Default)', { exact: true })).toBeVisible();
      await browser.keyboard.press('Escape');
    }
    await app.open('/manager/new');
    await expect(screen.getByRole('textbox', 'What should this manager do?')).toBeVisible();
    await expect(screen.getByRole('button', 'Start dictation')).toHaveCount(0);
    await expect(screen.getByRole('button', 'Options', { exact: true })).toHaveCount(0);
  } finally {
    await fetch(new URL(`/api/v1/workspace/managers/${manager.id}`, base), { method: 'DELETE' });
  }
});
