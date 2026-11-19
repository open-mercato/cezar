import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { managerListResponseSchema, managerSummarySchema } from '@open-mercato/cezar-contract';

test('workspace approvals navigate, confirm and dismiss on desktop and mobile', { trace: 'on', timeout: 120_000 }, async ({ app, screen, browser }) => {
  if (!app.baseUrl) throw new Error('The cockpit URL is required');
  const base = app.baseUrl;
  const call = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    const response = await fetch(new URL(`/api/v1/workspace/managers${path}`, base), {
      method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const created: string[] = [];
  const make = async (name: string) => {
    const manager = managerSummarySchema.parse(await call('', 'POST', { name, instructions: '', projects: 'all', cronMinutes: 0, followUp: false }));
    created.push(manager.id);
    return manager;
  };
  const approvals = () => screen.getByRole('link', /^Approvals/, { visible: true });
  const summary = () => browser.locator('[data-route="manager-approvals"] header [role="status"]');
  const dialogSettled = () => expect.poll(() => browser.evaluate(() =>
    document.querySelector('[role="dialog"]')?.getAnimations().filter((animation) => animation.playState === 'running').length ?? -1)).toBe(0);
  try {
    const shop = await make('Shop Manager QA');
    const ops = await make('Ops Manager QA');
    for (const [manager, name] of [[ops, 'Audit dependencies QA'], [shop, 'Shop health check QA']] as const) {
      await call(`/${manager.id}/actions`, 'POST', { action: { type: 'add-job', name, prompt: 'Report project health.', everyMinutes: 60 } });
    }
    await browser.setViewport({ width: 1440, height: 1000 });
    await app.open(`/manager/${shop.id}`);
    await expect(approvals()).toBeVisible();
    await app.screenshot('approvals-before-navigation');
    // Shop is already open and is the first waiting manager: the old link goes nowhere.
    await approvals().focus();
    await browser.keyboard.press('Enter');
    await expect(browser).toHaveURL('/manager/approvals');
    await expect(approvals()).toHaveAttribute('aria-current', 'page');
    await expect(screen.getByText('Shop health check QA', { exact: true })).toBeVisible();
    await expect(screen.getByText('Audit dependencies QA', { exact: true })).toBeVisible();
    const total = managerListResponseSchema.parse(await call('')).managers.reduce((sum, manager) => sum + manager.pendingActions, 0);
    await expect(summary()).toHaveText(`${total} pending approvals across all managers`);
    await app.screenshot('approvals-desktop');

    await browser.reload();
    await expect(screen.getByText('Shop health check QA', { exact: true })).toBeVisible();
    const shopRegion = screen.getByRole('region', 'Shop Manager QA');
    await shopRegion.getByRole('button', 'Approve', { exact: true }).tap();
    await expect(screen.getByRole('dialog')).toBeVisible();
    await dialogSettled();
    await app.screenshot('approvals-desktop-confirmation');
    await screen.getByRole('button', 'Cancel', { exact: true }).tap();
    await screen.getByRole('link', 'Open chat with Shop Manager QA', { exact: true }).tap();
    await expect(browser.locator('[data-slot="manager-action"][data-status="pending"]')).toBeVisible();

    await browser.setViewport({ width: 390, height: 844 });
    await app.open('/manager/approvals');
    await screen.getByRole('button', 'Open menu', { exact: true }).tap();
    await expect(approvals()).toHaveAttribute('aria-current', 'page');
    await dialogSettled();
    await app.screenshot('approvals-mobile-menu');
    await approvals().tap();
    await expect(screen.getByRole('dialog')).toBeHidden();
    await expect(screen.getByRole('heading', 'Approvals', { exact: true })).toBeVisible();
    await app.screenshot('approvals-mobile');
    const opsRegion = screen.getByRole('region', 'Ops Manager QA');
    await opsRegion.getByRole('button', 'Approve', { exact: true }).scrollIntoView();
    await opsRegion.getByRole('button', 'Approve', { exact: true }).tap();
    await expect(screen.getByRole('dialog')).toBeVisible();
    await dialogSettled();
    await app.screenshot('approvals-mobile-confirmation');
    await screen.getByRole('button', 'Cancel', { exact: true }).tap();
    await opsRegion.getByRole('button', 'Dismiss', { exact: true }).focus();
    await browser.keyboard.press('Enter');
    await expect(opsRegion.getByText('Dismissed', { exact: true }).first()).toBeVisible();
    await expect.poll(() => browser.evaluate(() => document.activeElement?.textContent)).toBe('Approvals');
    await shopRegion.getByRole('button', 'Dismiss', { exact: true }).tap();
    await expect(shopRegion.getByText('Dismissed', { exact: true }).first()).toBeVisible();
    await app.screenshot('approvals-mobile-results');
    await screen.getByRole('button', 'Clear results', { exact: true }).tap();
    if (total === 2) {
      await expect(screen.getByRole('heading', 'No pending approvals', { exact: true })).toBeVisible();
      await browser.reload();
      await expect(screen.getByRole('heading', 'No pending approvals', { exact: true })).toBeVisible();
      await app.screenshot('approvals-mobile-empty');
    }
    expect(await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await app.open('/manager/approvals');
    for (const id of created) await call(`/${id}`, 'DELETE');
  }
});

test('a failed approval keeps its server result visible on desktop and mobile', { trace: 'on', timeout: 90_000 }, async ({ app, screen, browser }) => {
  if (!app.baseUrl) throw new Error('The cockpit URL is required');
  const base = app.baseUrl;
  const call = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    const response = await fetch(new URL(`/api/v1/workspace/managers${path}`, base), {
      method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const manager = managerSummarySchema.parse(await call('', 'POST', { name: 'Approval failure QA', instructions: '', projects: 'all', cronMinutes: 0, followUp: false }));
  try {
    // Fill the job registry with disabled jobs: approving one more must fail without enabling
    // anything. The decision route still answers HTTP 200; its action carries the refusal.
    await call(`/${manager.id}`, 'PATCH', { jobs: Array.from({ length: 32 }, (_, index) => ({
      name: `Disabled job ${index}`, prompt: 'Never run.', everyMinutes: 60, enabled: false,
    })) });
    for (const width of [1440, 390]) {
      await call(`/${manager.id}/actions`, 'POST', { action: { type: 'add-job', name: `No capacity ${width}`, prompt: 'Report health.', everyMinutes: 60 } });
      await browser.setViewport({ width, height: width === 390 ? 844 : 1000 });
      await app.open('/manager/approvals');
      const region = screen.getByRole('region', 'Approval failure QA');
      await region.getByRole('button', 'Approve', { exact: true }).tap();
      await screen.getByRole('dialog').getByRole('button', 'Add job', { exact: true }).tap();
      await expect(screen.getByText('a manager holds at most 32 jobs', { exact: true })).toBeVisible();
      await expect(region.getByText('Failed', { exact: true }).first()).toBeVisible();
      await expect(screen.getByText('0 pending approvals across all managers', { exact: true })).toBeVisible();
      await expect(screen.getByRole('dialog')).toBeHidden();
      await app.screenshot(`approvals-failed-${width}`);
      await screen.getByRole('button', 'Clear results', { exact: true }).tap();
      await expect(screen.getByRole('heading', 'No pending approvals', { exact: true })).toBeVisible();
    }
  } finally {
    await call(`/${manager.id}`, 'DELETE');
  }
});
