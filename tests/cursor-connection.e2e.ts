import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Synthetic account/catalog responses keep this browser check off real vendor credentials.
for (const [width, height] of [[1280, 720], [390, 844]]) {
  test(`Cursor connection remains actionable at ${width}px for an existing login`, { timeout: 60_000 }, async ({ app, screen, browser }) => {
    await browser.setViewport({ width, height });
    let modelReads = 0;
    await browser.route('**/api/v1/models?*', async (route) => {
      const runner = new URL(route.request.url).searchParams.get('runner');
      if (runner === 'cursor') modelReads++;
      await route.fulfill({ json: { runner, source: 'live', stale: false,
        models: runner === 'cursor' ? [{ id: 'composer-2.5', label: 'Composer 2.5', description: '' }] : [],
      } });
    });
    await browser.route('**/api/v1/workspace/agent-profiles', (route) => route.fulfill({ json: {
      editable: true, profileCapableProviders: ['claude', 'codex'], defaults: {}, selections: {}, profiles: [{
        id: 'default', provider: 'cursor', label: 'Default', configDir: '~/.cursor', path: '/test/.cursor',
        isDefault: true, exists: true, looksValid: true, files: [], status: { provider: 'cursor', status: 'connected' },
      }],
    } }));
    await browser.route('**/api/v1/providers/status*', (route) => route.fulfill({ json: { providers: [
      { provider: 'claude', status: 'connected', enabled: true }, { provider: 'cursor', status: 'connected', enabled: true },
    ] } }));
    await browser.route('**/api/v1/providers/connect', async (route) => {
      expect(JSON.parse(route.request.postData ?? '{}')).toEqual({ provider: 'cursor', reconnect: true });
      await route.fulfill({ status: 409, json: { error: 'Run this command manually.', command: 'cursor-agent login' } });
    });
    await browser.route('**/api/v1/workspace/agent-profiles/default%3Acursor/status?*', (route) => route.fulfill({ json: { status: { provider: 'cursor', status: 'connected' } } }));
    await app.open('/settings/global/agents');
    await expect(screen.getByRole('button', 'Sign in again')).toBeVisible();
    await expect(screen.getByText('Composer 2.5', { exact: true })).toBeVisible();
    await expect(screen.getByText('attaching or listing existing Cloud Agent sessions is not supported here', { exact: false })).toBeVisible();
    await screen.getByRole('button', 'Sign in again').tap();
    await expect(screen.getByText('cursor-agent login', { exact: true })).toBeVisible();
    const before = modelReads;
    await screen.getByRole('button', 'Verify connection').tap();
    await expect.poll(() => modelReads).toBeGreaterThan(before);
    await expect.poll(() => browser.evaluate(() => {
      const panel = document.querySelector('[data-slot="cursor-connection"]')!;
      const box = panel.getBoundingClientRect();
      return panel.scrollWidth <= panel.clientWidth && box.left >= 0 && box.right <= innerWidth;
    })).toBe(true);
    await app.screenshot(`cursor-connected-${width}`);
    await screen.getByRole('link', 'New task with Cursor').tap();
    await expect.poll(() => browser.evaluate(() => document.querySelector('[data-slot="runner-pill"]')?.textContent)).toContain('cursor');
    await expect(screen.getByRole('textbox', 'Describe a task for the agent')).toHaveValue('');
    await app.screenshot(`cursor-new-task-${width}`);
  });
}
