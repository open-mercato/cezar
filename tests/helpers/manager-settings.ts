import { expect, type Screen } from 'e2e';
import type { Browser } from '@e2e-dev/web';

/** Manager configuration is reached through the header gear, at every viewport width. */
export async function openManagerSettings(screen: Screen, browser: Browser): Promise<void> {
  // A closing nested menu temporarily hides its parent dialog from the accessibility tree.
  if (await browser.locator('[data-slot="manager-agent-dialog"]').count()) {
    await expect(screen.getByRole('dialog', 'Manager agent')).toBeVisible();
    return;
  }
  const gear = screen.getByRole('button', 'Manager settings', { visible: true });
  await expect(gear).toBeVisible();
  if (await gear.getAttribute('aria-expanded') !== 'true') await gear.tap();
  await screen.getByRole('button', 'Manager agent…').tap();
  await expect(screen.getByRole('dialog', 'Manager agent')).toBeVisible();
}
