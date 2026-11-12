import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('the cockpit shell renders', { tags: ['smoke'] }, async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('main')).toBeVisible();
  // Two landmarks: the sidebar's page list and the workspace's project/task controls.
  await expect(screen.getByRole('navigation', 'Main')).toBeVisible();
  await expect(screen.getByRole('navigation', 'Workspace')).toBeVisible();
});
