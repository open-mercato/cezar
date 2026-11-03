import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('new tracker automations start read-only and require individual write grants', async ({ app, screen, browser }) => {
  const association = { kind: 'jira', source: { id: 'cloud', webUrl: 'https://example.atlassian.net' }, externalId: '100', externalName: 'Team', connectionId: '11111111-1111-4111-8111-111111111111' };
  await browser.route('**/tracker/automation-options*', route => route.fulfill({ json: { available: true, association, events: ['issue.opened'], statuses: [], labels: [], limitations: [] } }));
  await app.open('/automations/new');
  await screen.getByRole('button', 'When Jira / Linear changes').tap();
  await screen.getByRole('button', 'issue.opened').tap();
  const comments = screen.getByRole('checkbox', 'Allow agent to post comments on this issue without further approval');
  const status = screen.getByRole('checkbox', 'Allow agent to change status on this issue without further approval');
  await expect(comments).not.toBeChecked();
  await expect(status).not.toBeChecked();
  await comments.tap();
  await expect(comments).toBeChecked();
  await expect(status).not.toBeChecked();
  await comments.tap();
  await expect(comments).not.toBeChecked();
});
