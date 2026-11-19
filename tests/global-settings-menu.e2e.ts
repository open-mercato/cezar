import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('Global Settings in the machine menu navigates and stays accessible on desktop and mobile', { trace: 'on', timeout: 120_000 }, async ({ app, screen, browser }) => {
  const more = () => screen.getByRole('button', 'More', { exact: true, visible: true });
  const settings = () => screen.getByRole('menuitem', 'Global Settings', { exact: true });
  const menu = () => browser.locator('[data-slot="sidebar-more-content"]');
  const screenshot = async (name: string) => {
    await expect.poll(() => browser.evaluate(() =>
      [...document.querySelectorAll('[data-slot="sidebar-more-content"], [role="dialog"]')]
        .every((node) => node.getAnimations().every((animation) => animation.playState !== 'running')))).toBe(true);
    const path = await app.screenshot(name);
    if (process.env.CEZ_ARTIFACTS_DIR) {
      mkdirSync(process.env.CEZ_ARTIFACTS_DIR, { recursive: true });
      copyFileSync(path, join(process.env.CEZ_ARTIFACTS_DIR, `${name}.png`));
    }
  };
  const drawerSettled = () => expect.poll(() => browser.evaluate(() =>
    document.querySelector('[role="dialog"]')?.getAnimations().filter((animation) => animation.playState === 'running').length ?? -1)).toBe(0);

  await browser.setViewport({ width: 1440, height: 1000 });
  await app.open('/dashboard');
  await more().focus();
  await browser.keyboard.press('ArrowDown');
  await expect(settings()).toBeFocused();
  await expect(settings()).toHaveAttribute('href', '/settings/global');
  await expect(settings()).not.toHaveAttribute('aria-current');
  await expect(screen.getByRole('menuitem', 'Tools', { exact: true })).toBeVisible();
  await expect(screen.getByRole('menuitem', /What.s new/)).toBeVisible();
  await expect(screen.getByRole('menuitemradio', 'Dark', { exact: true })).toBeVisible();
  await screenshot('global-settings-desktop-menu');
  await browser.keyboard.press('ArrowDown');
  await expect(screen.getByRole('menuitem', 'Tools', { exact: true })).toBeFocused();
  await browser.keyboard.press('ArrowRight');
  await expect(browser.locator('[data-slot="tools-menu-content"]')).toBeVisible();
  await browser.keyboard.press('ArrowLeft');
  await expect(screen.getByRole('menuitem', 'Tools', { exact: true })).toBeFocused();
  await browser.keyboard.press('Escape');
  await expect(menu()).toBeHidden();
  await expect(more()).toBeFocused();
  await browser.keyboard.press('ArrowDown');
  await expect(settings()).toBeFocused();
  await browser.keyboard.press('Enter');
  await expect(browser).toHaveURL('/settings/global/appearance');
  await expect(menu()).toBeHidden();
  await more().tap();
  await expect(settings()).toHaveAttribute('aria-current', 'page');
  await screenshot('global-settings-desktop-selected');
  await browser.keyboard.press('Escape');
  await expect(more()).toBeFocused();

  await browser.setViewport({ width: 390, height: 844 });
  await app.open('/dashboard');
  await screen.getByRole('button', 'Open menu', { exact: true }).tap();
  await drawerSettled();
  await more().tap();
  await expect(settings()).toBeVisible();
  await expect(settings()).not.toHaveAttribute('aria-current');
  const box = await settings().boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  expect(box?.width).toBeGreaterThanOrEqual(44);
  await screenshot('global-settings-mobile-menu');
  await browser.keyboard.press('Escape');
  await expect(menu()).toBeHidden();
  await expect(more()).toBeFocused();
  await expect(screen.getByRole('dialog', 'Navigation', { exact: true })).toBeVisible();
  await more().tap();
  await settings().tap();
  await expect(browser).toHaveURL('/settings/global/appearance');
  await expect(menu()).toBeHidden();
  await expect(screen.getByRole('dialog')).toBeHidden();
  await expect(screen.getByRole('button', 'Open settings menu', { exact: true })).toBeVisible();
  await screenshot('global-settings-mobile-arrival');
  await screen.getByRole('button', 'Open settings menu', { exact: true }).tap();
  await drawerSettled();
  await more().tap();
  await expect(settings()).toHaveAttribute('aria-current', 'page');
  await screenshot('global-settings-mobile-selected');
  await browser.keyboard.press('Escape');
  await expect(more()).toBeFocused();
  await browser.keyboard.press('Escape');
  await expect(screen.getByRole('dialog')).toBeHidden();
  await expect(screen.getByRole('button', 'Open settings menu', { exact: true })).toBeFocused();
  await screen.getByRole('button', 'Open settings menu', { exact: true }).tap();
  await drawerSettled();
  await more().tap();
  // Re-selecting Global Settings follows its index redirect and closes both layers too.
  await settings().tap();
  await expect(browser).toHaveURL('/settings/global/appearance');
  await expect(menu()).toBeHidden();
  await expect(screen.getByRole('dialog')).toBeHidden();
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
