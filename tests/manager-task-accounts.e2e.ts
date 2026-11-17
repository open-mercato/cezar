import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { openManagerSettings } from './helpers/manager-settings';
import { agentProfileResponseSchema, apiRunSchema, managerCreateTaskResponseSchema, managerSummarySchema, registerProjectResponseSchema } from '@open-mercato/cezar-contract';

test('a phone selects two Claude accounts and one Codex account for newly spawned tasks', { trace: 'on', timeout: 180_000 }, async ({ app, screen, browser }) => {
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
  const root = mkdtempSync(join(tmpdir(), 'cez-manager-account-pool-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, timeout: 10_000 });
  execFileSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'test: account pool fixture', '--allow-empty'], { cwd: repo, timeout: 10_000 });
  const { project } = registerProjectResponseSchema.parse(await call('/projects', 'POST', { root: repo }));
  const profiles = [];
  for (const [provider, label] of [['claude', 'QA Claude One'], ['claude', 'QA Claude Two'], ['codex', 'QA Codex']] as const) {
    const configDir = join(root, label);
    mkdirSync(configDir);
    profiles.push(agentProfileResponseSchema.parse(await call('/workspace/agent-profiles', 'POST', { provider, label, configDir })).profile);
  }
  const agents = profiles.map((profile) => ({ runner: profile.provider, agentProfile: profile.id }));
  const manager = managerSummarySchema.parse(await call('/workspace/managers', 'POST', {
    name: 'Account pool QA', instructions: '', projects: [project.id], runner: 'codex', agentProfile: 'default', cronMinutes: 0, followUp: false,
  }));
  const path = `/workspace/managers/${manager.id}`;
  const runs: string[] = [];
  await call(path, 'PATCH', { followUp: false });
  try {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open(`/manager/${manager.id}`);
    await openManagerSettings(screen, browser);
    await screen.getByRole('button', 'Agent for new tasks', { visible: true }).tap();
    for (const profile of profiles) {
      const item = screen.getByRole('menuitemcheckbox', `${profile.provider} · ${profile.label}`, { exact: true });
      await item.scrollIntoView();
      await item.tap();
    }
    await browser.keyboard.press('Escape');
    const saved = async () => managerSummarySchema.parse(await call(path));
    await expect.poll(async () => JSON.stringify((await saved()).taskAgents)).toBe(JSON.stringify(agents));
    expect(await saved()).toMatchObject({ runner: 'codex', agentProfile: 'default' });
    await browser.reload();
    await openManagerSettings(screen, browser);
    await expect(screen.getByRole('button', 'Agent for new tasks', { visible: true })).toContainText('3 accounts');
    await openManagerSettings(screen, browser);
    await screen.getByRole('button', 'Agent for new tasks', { visible: true }).tap();
    for (const profile of profiles) {
      await expect(screen.getByRole('menuitemcheckbox', `${profile.provider} · ${profile.label}`, { exact: true })).toHaveAttribute('aria-checked', 'true');
    }
    await browser.keyboard.press('Escape');
    for (const agent of agents) {
      const created = managerCreateTaskResponseSchema.parse(await call(`${path}/tasks`, 'POST', {
        projectId: project.id, task: 'Say hello. mock:done', ...agent,
      }));
      runs.push(created.runId);
      const record = async () => apiRunSchema.parse(await call(`/p/${project.id}/runs/${created.runId}`));
      await expect.poll(async () => (await record()).runner).toBe(agent.runner);
      expect((await record()).agentProfile).toBe(agent.agentProfile);
      await expect.poll(async () => (await record()).steps.find((step) => step.kind === 'agent')?.profileId, { timeout: 20_000 }).toBe(agent.agentProfile);
      expect((await record()).steps.find((step) => step.kind === 'agent')?.backend).toBe(agent.runner);
      await call(`/p/${project.id}/runs/${created.runId}/cancel`, 'POST', {});
    }
    await app.open(`/p/${project.id}/tasks/${runs[1]}/chat`);
    await expect(screen.getByRole('button', 'Agent: claude, account QA Claude Two, model auto', { exact: true })).toBeVisible({ timeout: 20_000 });
    await app.open(`/manager/${manager.id}`);
    const refused = await fetch(new URL(`/api/v1${path}/tasks`, base), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, task: 'Unselected account', runner: 'claude', agentProfile: 'default' }),
    });
    expect(refused.status).toBe(403);
    await openManagerSettings(screen, browser);
    await screen.getByRole('button', 'Agent for new tasks', { visible: true }).tap();
    await screen.getByRole('menuitemcheckbox', 'Automatic', { exact: true }).tap();
    await browser.keyboard.press('Escape');
    await expect.poll(async () => (await saved()).taskAgents ?? null).toBe(null);
    await browser.reload();
    await openManagerSettings(screen, browser);
    await expect(screen.getByRole('button', 'Agent for new tasks', { visible: true })).toContainText('Automatic');
  } finally {
    for (const id of runs) await call(`/p/${project.id}/runs/${id}/cancel`, 'POST', {}).catch(() => undefined);
    await call(path, 'DELETE');
    await call(`/projects/${project.id}`, 'DELETE');
    for (const profile of profiles) await call(`/workspace/agent-profiles/${profile.id}`, 'DELETE');
    rmSync(root, { recursive: true, force: true });
  }
});
