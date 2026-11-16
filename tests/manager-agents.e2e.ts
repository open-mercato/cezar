import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
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
    await expect.poll(async () => apiRunSchema.parse(await call(`/p/${projectId}/runs/${created.runId}`)).steps.find((step) => step.kind === 'agent')?.backend).toBe('codex');
  };
  try {
    await app.open(`/manager/${manager.id}`);
    await screen.getByRole('button', 'Agent for new tasks').first().tap();
    await screen.getByRole('menuitemradio', 'codex', { exact: true }).tap();
    await expect.poll(async () => managerSummarySchema.parse(await call(path)).taskRunner).toBe('codex');
    await startTask('claude');

    await screen.getByRole('button', 'Model and effort').first().tap();
    await screen.getByRole('menuitemradio', 'codex', { exact: true }).tap();
    await expect.poll(async () => managerSummarySchema.parse(await call(path)).runner).toBe('codex');
    await screen.getByRole('button', 'Model and effort').first().tap();
    await screen.getByRole('menuitemradio', 'Task agent QA', { exact: true }).tap();
    await expect.poll(async () => managerSummarySchema.parse(await call(path)).agentProfile).toBe(profile.id);
    await browser.reload();
    await screen.getByRole('button', 'Model and effort').first().tap();
    await expect(screen.getByRole('menuitemradio', 'Task agent QA', { exact: true })).toHaveAttribute('aria-checked', 'true');
    await app.screenshot('manager-agent-account');
    await browser.keyboard.press('Escape');

    await screen.getByRole('button', 'Agent for new tasks').first().tap();
    await screen.getByRole('menuitemradio', 'Automatic', { exact: true }).tap();
    await expect.poll(async () => managerSummarySchema.parse(await call(path)).taskRunner ?? null).toBe(null);
    await startTask();
    await browser.setViewport({ width: 390, height: 844 });
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
