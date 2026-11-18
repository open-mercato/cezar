import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { apiRunSchema, registerProjectResponseSchema, runRecordSchema } from '@open-mercato/cezar-contract';

test('the task composer answers the review gate and opens the PR', async ({ app, screen }) => {
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
  const repo = mkdtempSync(join(tmpdir(), 'cezar-workflow-gate-'));
  let projectId: string | undefined;
  let runPath: string | undefined;
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, timeout: 10_000 });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --version' } }));
    git('add', 'package.json');
    git('-c', 'user.name=QA', '-c', 'user.email=qa@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'test: initialize gate fixture');
    const { project } = registerProjectResponseSchema.parse(await call('/projects', 'POST', { root: repo }));
    projectId = project.id;
    const { id } = runRecordSchema.parse(await call(`/p/${project.id}/runs`, 'POST', {
      task: 'Improve the project notes. mock:verdict=approve',
      workflow: 'implement-review-pr',
      runner: 'claude',
    }));
    const path = `/p/${project.id}/runs/${id}`;
    runPath = path;
    const record = async () => apiRunSchema.parse(await call(path));
    await expect.poll(async () => (await record()).steps.find((step) => step.id === 'gate')?.status, { timeout: 20_000 }).toBe('waiting');
    expect((await record()).pullRequestUrl).toBeUndefined();

    await app.open(`/p/${project.id}/tasks/${id}/chat`);
    await expect(screen.getByText(/Review verdict: approve/)).toBeVisible();
    const reply = 'Check the release notes first. mock:verdict=applied';
    await screen.getByRole('textbox', 'Reply to the agent').fill(reply);
    await screen.getByRole('button', 'Send', { exact: true }).tap();

    await expect.poll(async () => (await record()).status, { timeout: 20_000 }).toMatch(/^(done|review|failed)$/);
    const final = await record();
    expect(final.status).toMatch(/^(done|review)$/);
    expect(final.error).toBeUndefined();
    expect(final.pullRequestUrl).toBe('https://github.com/open-mercato/demo/pull/777');
    expect(final.steps.find((step) => step.id === 'gate')).toMatchObject({ id: 'gate', status: 'done', sessionId: expect.any(String) });
  } finally {
    if (runPath) await call(`${runPath}/cancel`, 'POST', {}).catch(() => undefined);
    if (projectId) await call(`/projects/${projectId}`, 'DELETE');
    rmSync(repo, { recursive: true, force: true });
  }
});
