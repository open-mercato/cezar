import { describe, test } from '@e2e-dev/web';
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

describe('tracker', { tags: ['tracker'] }, () => {
  test('/tracker without a connection offers the setup door into settings', async ({ app, screen, browser }) => {
    await app.open('/tracker');
    await expect(browser).toHaveURL(/\/p\/[^/]+\/tracker$/);
    await expect(screen.getByRole('heading', 'Connect an issue tracker', { level: 1 })).toBeVisible();
    await expect(screen.getByText('Choose a project or team from your issue tracker in project settings.')).toBeVisible();
    await screen.getByRole('link', 'Open tracker settings').tap();
    await expect(browser).toHaveURL(/\/p\/[^/]+\/settings\/tracker$/);
  });

  test('/tracker/:id without a connection renders the same setup state, not an error', async ({ app, screen, browser }) => {
    await app.open('/tracker/E2E-1');
    await expect(browser).toHaveURL(/\/p\/[^/]+\/tracker\/E2E-1$/);
    await expect(screen.getByRole('heading', 'Connect an issue tracker', { level: 1 })).toBeVisible();
    await expect(screen.getByRole('link', 'Open tracker settings')).toBeVisible();
  });
});
