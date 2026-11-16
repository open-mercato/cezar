import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { openManagerSettings } from './helpers/manager-settings';
import { agentProfileResponseSchema, apiRunSchema, managerCreateTaskResponseSchema, managerSummarySchema } from '@open-mercato/cezar-contract';

test('manager accounts and task agents persist and reach the launched task', { trace: 'on', timeout: 90_000 }, async ({ app, screen, browser }) => {
  const base = app.baseUrl;
  if (!base) throw new Error('The cockpit URL is required');
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(new URL(`/api/v1${path}`, base), {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<unknown>;
  };
  const configDir = mkdtempSync(join(tmpdir(), 'cez-e2e-codex-account-'));
  const { profile } = agentProfileResponseSchema.parse(await call('/workspace/agent-profiles', 'POST', { provider: 'codex', label: 'Task agent QA', configDir }));
  const manager = managerSummarySchema.parse(await call('/workspace/managers', 'POST', {
    name: 'Agent chooser', instructions: '', projects: 'all', runner: 'claude', cronMinutes: 0,
  }));
  const path = `/workspace/managers/${manager.id}`;
  const projectId = manager.connectedProjectIds[0];
  if (!projectId) throw new Error('A connected project is required');
  const runs: string[] = [];
  const startTask = async (runner?: string) => {
    const created = managerCreateTaskResponseSchema.parse(await call(`${path}/tasks`, 'POST', {
      projectId, task: 'Say hello. mock:done', ...(runner ? { runner } : {}),
    }));
    runs.push(created.runId);
    await expect.poll(async () => apiRunSchema.parse(await call(`/p/${projectId}/runs/${created.runId}`)).runner).toBe('codex');
    await expect.poll(async () => apiRunSchema.parse(await call(`/p/${projectId}/runs/${created.runId}`)).steps.find((step) => step.kind === 'agent')?.backend, { timeout: 20_000 }).toBe('codex');
  };
  try {
    await app.open(`/manager/${manager.id}`);
    await openManagerSettings(screen);
    await screen.getByRole('button', 'Agent for new tasks').first().tap();
    await screen.getByRole('menuitemcheckbox', 'codex · Default', { exact: true }).tap();
    await browser.keyboard.press('Escape');
    await expect.poll(async () => managerSummarySchema.parse(await call(path)).taskAgents?.[0]?.runner).toBe('codex');
    await startTask('codex');

    await openManagerSettings(screen);
    await screen.getByRole('button', 'Model and effort').first().tap();
    await screen.getByRole('menuitemradio', 'codex', { exact: true }).tap();
    await expect.poll(async () => managerSummarySchema.parse(await call(path)).runner).toBe('codex');
    await openManagerSettings(screen);
    await screen.getByRole('button', 'Model and effort').first().tap();
    await screen.getByRole('menuitemradio', 'Task agent QA', { exact: true }).tap();
    await expect.poll(async () => managerSummarySchema.parse(await call(path)).agentProfile).toBe(profile.id);
    await browser.reload();
    await openManagerSettings(screen);
    await screen.getByRole('button', 'Model and effort').first().tap();
    await expect(screen.getByRole('menuitemradio', 'Task agent QA', { exact: true })).toHaveAttribute('aria-checked', 'true');
    await app.screenshot('manager-agent-account');
    await browser.keyboard.press('Escape');

    await openManagerSettings(screen);
    await screen.getByRole('button', 'Agent for new tasks').first().tap();
    await screen.getByRole('menuitemcheckbox', 'Automatic', { exact: true }).tap();
    await browser.keyboard.press('Escape');
    await expect.poll(async () => managerSummarySchema.parse(await call(path)).taskAgents ?? null).toBe(null);
    await startTask();
    await browser.setViewport({ width: 390, height: 844 });
    await openManagerSettings(screen);
    await expect(screen.getByRole('button', 'Agent for new tasks', { visible: true })).toContainText('Automatic');
    await app.screenshot('manager-task-agent-mobile');
  } finally {
    await app.open('/manager/new');
    for (const runId of runs) await call(`/p/${projectId}/runs/${runId}/cancel`, 'POST', {}).catch(() => undefined);
    await call(path, 'DELETE');
    await call(`/workspace/agent-profiles/${profile.id}`, 'DELETE');
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('long manager account names stay selectable in narrow model and account menus', { trace: 'on', timeout: 90_000 }, async ({ app, screen, browser }) => {
  const base = app.baseUrl;
  if (!base) throw new Error('The cockpit URL is required');
  const call = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    const response = await fetch(new URL(`/api/v1${path}`, base), {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const configDir = mkdtempSync(join(tmpdir(), 'cez-e2e-long-account-'));
  const label = `QA Work ${'LongAccountLabel'.repeat(10)}`;
  const { profile } = agentProfileResponseSchema.parse(await call('/workspace/agent-profiles', 'POST', { provider: 'codex', label, configDir }));
  const manager = managerSummarySchema.parse(await call('/workspace/managers', 'POST', {
    name: 'Narrow account menus', instructions: '', projects: 'all', runner: 'codex', cronMinutes: 0,
  }));
  const path = `/workspace/managers/${manager.id}`;
  const menuRight = () => browser.evaluate(() =>
    document.querySelector('[data-slot="dropdown-menu-content"][data-state="open"]')?.getBoundingClientRect().right ?? 9999);
  try {
    await call('/workspace/agent-profiles/selection', 'PUT', { projectId: null, provider: 'codex', profileId: profile.id });
    for (const width of [320, 390]) {
      await browser.setViewport({ width, height: 844 });
      await app.open(`/manager/${manager.id}`);
      await openManagerSettings(screen);
      await screen.getByRole('button', 'Model and effort', { visible: true }).tap();
      await screen.getByRole('menuitemradio', label, { exact: true }).scrollIntoView();
      await expect.poll(menuRight).toBeLessThanOrEqual(width);
      await expect.poll(() => browser.evaluate(() => {
        const menu = document.querySelector('[data-slot="dropdown-menu-content"][data-state="open"]');
        return menu ? Number(getComputedStyle(menu).opacity) : 0;
      })).toBe(1);
      await app.screenshot(`manager-account-menu-${width}`);
      await screen.getByRole('menuitemradio', label, { exact: true }).tap();
      await expect.poll(async () => managerSummarySchema.parse(await call(path)).agentProfile).toBe(profile.id);
      await openManagerSettings(screen);
      await screen.getByRole('button', 'Agent account').tap();
      await expect.poll(menuRight).toBeLessThanOrEqual(width);
      await expect.poll(() => browser.evaluate(() => {
        const menu = document.querySelector('[data-slot="dropdown-menu-content"][data-state="open"]');
        return menu ? Number(getComputedStyle(menu).opacity) : 0;
      })).toBe(1);
      await app.screenshot(`manager-account-settings-${width}`);
      await screen.getByRole('menuitemradio', `Use workspace default (${label})`, { exact: true }).tap();
      await expect.poll(async () => managerSummarySchema.parse(await call(path)).agentProfile ?? null).toBe(null);
      await browser.keyboard.press('Escape');
    }
  } finally {
    await app.open('/manager/new');
    await call(path, 'DELETE');
    await call('/workspace/agent-profiles/selection', 'PUT', { projectId: null, provider: 'codex', profileId: null });
    await call(`/workspace/agent-profiles/${profile.id}`, 'DELETE');
    rmSync(configDir, { recursive: true, force: true });
  }
});
