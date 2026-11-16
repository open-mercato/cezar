import type { Screen } from 'e2e';

/** Manager configuration is reached through the header gear, at every viewport width. */
export async function openManagerSettings(screen: Screen): Promise<void> {
  const gear = screen.getByRole('button', 'Manager settings', { visible: true });
  if (await gear.getAttribute('aria-expanded') !== 'true') await gear.tap();
}
