import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { openManagerSettings } from './helpers/manager-settings';
import { apiRunSchema, managerCreateTaskResponseSchema, managerSummarySchema, registerProjectResponseSchema, runnerSchema } from '@open-mercato/cezar-contract';

test('phone task-agent choices persist and control newly spawned task metadata and backend', { trace: 'on', timeout: 240_000 }, async ({ app, screen, browser }) => {
  const base = app.baseUrl;
  if (!base) throw new Error('The cockpit URL is required');
  const call = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    const response = await fetch(new URL(`/api/v1${path}`, base), {
      method, headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const repo = mkdtempSync(join(tmpdir(), 'cez-phone-task-agents-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, timeout: 10_000 });
  execFileSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'test: initialize fixture', '--allow-empty'], { cwd: repo, timeout: 10_000 });
  const { project } = registerProjectResponseSchema.parse(await call('/projects', 'POST', { root: repo }));
  const projectId = project.id;
  const manager = managerSummarySchema.parse(await call('/workspace/managers', 'POST', {
    name: 'Phone task agents', instructions: '', projects: [projectId], runner: 'codex', agentProfile: 'default', cronMinutes: 0, followUp: false,
  }));
  const path = `/workspace/managers/${manager.id}`;
  const runIds: string[] = [];
  await call(path, 'PATCH', { followUp: false });
  try {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open(`/manager/${manager.id}`);
    // Explicit pins must override a contrary agent request; Automatic may choose per task.
    for (const choice of [...runnerSchema.options, null]) {
      await openManagerSettings(screen, browser);
      await screen.getByRole('button', 'Agent for new tasks', { visible: true }).tap();
      await screen.getByRole('menuitemcheckbox', 'Automatic', { exact: true }).tap();
      const option = screen.getByRole('menuitemcheckbox', choice ? `${choice} · Default` : 'Automatic', { exact: true });
      await option.scrollIntoView();
      await option.tap();
      await browser.keyboard.press('Escape');
      await expect.poll(async () => JSON.stringify(managerSummarySchema.parse(await call(path)).taskAgents ?? null)).toBe(JSON.stringify(choice ? [{ runner: choice, agentProfile: 'default' }] : null));
      await browser.reload();
      await openManagerSettings(screen, browser);
      await screen.getByRole('button', 'Agent for new tasks', { visible: true }).tap();
      await expect(screen.getByRole('menuitemcheckbox', choice ? `${choice} · Default` : 'Automatic', { exact: true })).toHaveAttribute('aria-checked', 'true');
      await browser.keyboard.press('Escape');
      await expect(screen.getByRole('menu', 'Agent for new tasks')).toBeHidden();
      expect(managerSummarySchema.parse(await call(path))).toMatchObject({ runner: 'codex', agentProfile: 'default' });
      const expected = choice ?? 'codex';
      const created = managerCreateTaskResponseSchema.parse(await call(`${path}/tasks`, 'POST', {
        projectId, task: 'Say hello. mock:done', ...(choice ? { runner: choice, agentProfile: 'default' } : {}),
      }));
      runIds.push(created.runId);
      const record = async () => apiRunSchema.parse(await call(`/p/${projectId}/runs/${created.runId}`));
      await expect.poll(async () => (await record()).runner).toBe(expected);
      await expect.poll(async () => (await record()).steps.find((step) => step.kind === 'agent')?.backend, { timeout: 20_000 }).toBe(expected);
      expect((await record()).startedByManager).toMatchObject({ id: manager.id });
      await call(`/p/${projectId}/runs/${created.runId}/cancel`, 'POST', {});
      if (choice === 'codex') {
        await app.open(`/p/${projectId}/tasks/${created.runId}/chat`);
        await expect(screen.getByRole('button', /^Agent: codex,/)).toBeVisible({ timeout: 20_000 });
        await app.open(`/manager/${manager.id}`);
      }
    }
    // With Automatic, an explicit per-task request remains a valid choice too.
    const created = managerCreateTaskResponseSchema.parse(await call(`${path}/tasks`, 'POST', {
      projectId, task: 'Say hello. mock:done', runner: 'claude',
    }));
    runIds.push(created.runId);
    await expect.poll(async () => apiRunSchema.parse(await call(`/p/${projectId}/runs/${created.runId}`)).runner).toBe('claude');
  } finally {
    for (const id of runIds) await call(`/p/${projectId}/runs/${id}/cancel`, 'POST', {}).catch(() => undefined);
    await call(path, 'DELETE');
    await call(`/projects/${projectId}`, 'DELETE');
    rmSync(repo, { recursive: true, force: true });
  }
});

test('phone and tablet keep both manager and task-agent controls readable and reachable', { trace: 'on', timeout: 90_000 }, async ({ app, screen, browser }) => {
  const base = app.baseUrl;
  if (!base) throw new Error('The cockpit URL is required');
  const response = await fetch(new URL('/api/v1/workspace/managers', base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Responsive agents', instructions: '', projects: 'all', runner: 'opencode', taskRunner: 'antigravity', cronMinutes: 0, followUp: false }),
  });
  const manager = managerSummarySchema.parse(await response.json());
  try {
    for (const size of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
      await browser.setViewport(size);
      await app.open(`/manager/${manager.id}`);
      await openManagerSettings(screen, browser);
      const taskPicker = screen.getByRole('button', 'Agent for new tasks', { visible: true });
      await openManagerSettings(screen, browser);
      const modelPicker = screen.getByRole('button', 'Model and effort', { visible: true });
      await expect(taskPicker).toContainText('Tasks: antigravity');
      await expect(modelPicker).toBeVisible();
      await expect.poll(() => browser.evaluate(() => {
        const visible = (slot: string) => [...document.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`)].filter((el) => el.getClientRects().length > 0);
        const buttons = [...visible('manager-task-runner-picker'), ...visible('manager-model-picker')];
        return buttons.every((button) => {
          const rect = button.getBoundingClientRect();
          const label = button.querySelector('span:last-child');
          return rect.left >= 0 && rect.right <= innerWidth && rect.width >= 44 && (!label || label.scrollWidth <= label.clientWidth);
        }) && document.documentElement.scrollWidth <= innerWidth;
      })).toBe(true);
      await taskPicker.tap();
      await expect(screen.getByRole('menuitemcheckbox', 'Automatic', { exact: true })).toBeVisible();
      await expect(screen.getByRole('menuitemcheckbox', 'antigravity · Automatic account', { exact: true })).toHaveAttribute('aria-checked', 'true');
      await app.screenshot(`task-agents-${size.width}x${size.height}`);
      await browser.keyboard.press('Escape');
      await screen.getByRole('button', 'Manager agent', { exact: true }).tap();
      await expect(screen.getByRole('menuitemradio', 'opencode', { exact: true })).toHaveAttribute('aria-checked', 'true');
      await browser.keyboard.press('Escape');
      await screen.getByRole('button', 'Done').tap();
      await screen.getByRole('textbox', `Message ${manager.name}`).fill('A task for the chosen agent');
      await expect(screen.getByRole('button', 'Send', { exact: true, visible: true })).toBeVisible();
    }
  } catch (error) {
    await app.screenshot('task-agent-layout-failure');
    throw error;
  } finally {
    await fetch(new URL(`/api/v1/workspace/managers/${manager.id}`, base), { method: 'DELETE' });
  }
});
