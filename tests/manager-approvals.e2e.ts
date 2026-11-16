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
    await expect(opsRegion).toBeHidden();
    await expect.poll(() => browser.evaluate(() => document.activeElement?.textContent)).toBe('Approvals');
    await shopRegion.getByRole('button', 'Dismiss', { exact: true }).tap();
    await expect(shopRegion).toBeHidden();
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
