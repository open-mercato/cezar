import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('the cockpit shell renders', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('main')).toBeVisible();
  await expect(screen.getByRole('navigation')).toBeVisible();
});

// With OPENAI_API_KEY in the environment, uncomment:
// test('the agent drives a flow', async ({ app, agent }) => {
//   await app.open('/');
//   await agent.act('open the Workflows page from the sidebar');
//   await agent.assert('a list of workflows including quick-task is shown');
// });
