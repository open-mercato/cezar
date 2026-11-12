import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';

/**
 * `/new` and its composer: the prompt box, the Start button, the Options panel (design
 * Proposal 5: every setting that is not a value pill lives behind "Options ⌄"), the one-time
 * tips, and a real quick-task run under the dry-run mock (`mock:done` makes it finish).
 */

const PROMPT = 'Describe a task for the agent';

/** The fixture repo this run's server was booted against (`e2e.config.ts` keys it by port). */
function fixtureRepo(baseUrl: string | undefined): string {
  const port = new URL(baseUrl ?? 'http://127.0.0.1:0').port;
  return resolve(`.e2e/fixtures/repo-${port}`);
}

/** A workflow the source pill can list: the fixture ships none, and `quick-task` is not a row. */
function seedWorkflow(repo: string): void {
  mkdirSync(join(repo, '.ai/cezar/workflows'), { recursive: true });
  writeFileSync(
    join(repo, '.ai/cezar/workflows/e2e-verify.yaml'),
    'name: e2e-verify\ndescription: Implement, then prove it with the tests\nsteps:\n  - id: implement\n    prompt: "{{task}}"\n',
  );
}

describe('new task', { tags: ['new-task'] }, () => {
  test('opens with the prompt focused and Start disabled until something is typed', async ({ app, screen, browser }) => {
    await app.open('/new');
    await expect(browser).toHaveURL(/\/p\/[^/]+\/new$/);
    await expect(screen.getByRole('main')).toBeVisible();
    await expect(screen.getByRole('heading', 'What should the agent work on?', { level: 1 })).toBeVisible();
    const prompt = screen.getByRole('textbox', PROMPT);
    await expect(prompt).toBeFocused();
    await expect(screen.getByRole('button', 'Start task')).toBeDisabled();
    await prompt.fill(`E2E ${Date.now()} typed`);
    await expect(screen.getByRole('button', 'Start task')).toBeEnabled();
    await prompt.clear();
    await expect(screen.getByRole('button', 'Start task')).toBeDisabled();
  });

  test('the Options panel opens below the composer with every labelled row', async ({ app, screen }) => {
    await app.open('/new');
    const prompt = screen.getByRole('textbox', PROMPT);
    await expect(prompt).toBeVisible();
    await screen.getByRole('button', 'Options').tap();
    const panel = screen.getByRole('dialog', 'Options');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Options · remembered for', { ignoreCase: true });
    // Below the prompt, never over it: the panel's top edge sits under the textbox.
    const box = await prompt.boundingBox();
    const panelBox = await panel.boundingBox();
    expect(panelBox!.y).toBeGreaterThan(box!.y + box!.height - 1);
    for (const label of ['Skill · workflow', 'Variants', 'Agent · model', 'Isolation', 'Mode', 'Base branch', 'Start']) {
      await expect(panel.getByText(label)).toBeVisible();
    }
    await expect(panel.getByRole('button', 'Choose a skill or workflow')).toBeVisible();
    await expect(panel.getByRole('button', 'Parallel variants')).toContainText('×1');
    await expect(panel.getByRole('button', 'Runner')).toBeVisible();
    await expect(panel.getByRole('button', 'Model')).toBeVisible();
    await expect(panel.getByRole('button', 'Isolation')).toHaveText('worktree');
    await expect(panel.getByRole('button', 'Mode')).toHaveText('supervised');
    await expect(panel.getByRole('button', 'Base branch')).toHaveText('main');
    // Deferred start moved into this panel: the Start row's chip opens the old picker.
    await expect(panel.getByRole('button', 'Choose task start time')).toHaveText('now');
    await expect(panel.getByRole('button', 'Reset to defaults')).toBeVisible();
    await prompt.press('Escape');
    await expect(panel).toBeHidden();
  });

  test('picking a workflow and a model updates the pills', async ({ app, screen, browser }) => {
    seedWorkflow(fixtureRepo(app.baseUrl));
    await app.open('/new');
    const source = screen.getByRole('button', 'Choose a skill or workflow');
    await expect(source).toHaveText('Skill');
    await source.tap();
    await expect(screen.getByPlaceholder('search skills & workflows…')).toBeVisible();
    await expect(screen.getByRole('option').filter({ hasText: 'No skill' })).toBeVisible();
    await screen.getByRole('option').filter({ hasText: 'e2e-verify' }).tap();
    await expect(source).toHaveText('e2e-verify');
    await expect(screen.getByRole('button', 'Clear the workflow e2e-verify')).toBeVisible();
    await screen.getByRole('button', 'Clear the workflow e2e-verify').tap();
    await expect(source).toHaveText('Skill');

    const model = screen.getByRole('button', 'Model');
    const before = await model.textContent();
    await model.tap();
    const items = screen.getByRole('menuitemradio');
    await expect(items.first()).toBeVisible();
    // Any preset other than the current one: the pill must follow the pick.
    const target = items.filter({ hasText: before === 'auto' ? 'sonnet' : 'auto' }).first();
    await target.tap();
    await expect(model).not.toHaveText(before ?? '');
    // Reopened, the menu (modal: the page behind it leaves the tree) marks the pick as checked.
    const picked = await model.textContent();
    await model.tap();
    await expect(screen.getByRole('menuitemradio', { checked: true })).toContainText(picked ?? '');
    await browser.keyboard.press('Escape');
    await expect(screen.getByRole('menuitemradio')).toHaveCount(0);
  });

  test('isolation and branch options: in place offers a new branch, Reset puts the worktree back', async ({ app, screen }) => {
    await app.open('/new');
    await expect(screen.getByText('Runs in an isolated worktree', { exact: false })).toBeVisible();
    await screen.getByRole('button', 'Options').tap();
    const panel = screen.getByRole('dialog', 'Options');
    await panel.getByRole('button', 'Isolation').tap();
    await screen.getByRole('menuitemradio').filter({ hasText: 'in place' }).tap();
    await expect(panel.getByRole('button', 'Isolation')).toHaveText('in place');
    const newBranch = panel.getByRole('checkbox', 'New branch');
    await expect(newBranch).not.toBeChecked();
    await newBranch.tap();
    await expect(newBranch).toBeChecked();
    await panel.getByRole('textbox', 'New branch name').fill('feat/e2e-branch');
    await expect(panel.getByRole('textbox', 'New branch name')).toHaveValue('feat/e2e-branch');
    await panel.getByRole('button', 'Reset to defaults').tap();
    await expect(panel.getByRole('button', 'Isolation')).toHaveText('worktree');
    await expect(panel.getByRole('checkbox', 'New branch')).toHaveCount(0);
  });

  test('Start runs a quick task to done under the mock agent', async ({ app, screen, browser }) => {
    await app.open('/new');
    await screen.getByRole('textbox', PROMPT).fill(`E2E ${Date.now()} start button mock:done`);
    await screen.getByRole('button', 'Start task').tap();
    await expect(browser).toHaveURL(/\/p\/[^/]+\/tasks\/[^/?]+/, { timeout: 15_000 });
    await expect(screen.getByRole('image', 'done')).toBeVisible({ timeout: 60_000 });
    // The draft is spent: coming back to /new starts empty.
    await app.open('/new');
    await expect(screen.getByRole('textbox', PROMPT)).toHaveValue('');
  });

  test('Ctrl+Enter starts the task from the keyboard', async ({ app, screen, browser }) => {
    await app.open('/new');
    const prompt = screen.getByRole('textbox', PROMPT);
    await prompt.fill(`E2E ${Date.now()} keyboard start mock:done`);
    // The shortcut is live once the composer can start: wait for the button it mirrors.
    await expect(screen.getByRole('button', 'Start task')).toBeEnabled();
    await prompt.press('Control+Enter');
    await expect(browser).toHaveURL(/\/p\/[^/]+\/tasks\/[^/?]+/, { timeout: 15_000 });
    await expect(screen.getByRole('image', 'done')).toBeVisible({ timeout: 60_000 });
  });

  test('the composer tips walk through and close', async ({ app, screen }) => {
    await app.open('/new');
    await expect(screen.getByRole('button', 'Options')).toBeEnabled();
    // Tips are remembered per workspace, so another test may have closed them: replay then.
    const tip = screen.getByRole('note', /^Tip: /);
    const link = screen.getByRole('button', /^(Tips|Show me around)$/);
    await expect.poll(async () => (await tip.isVisible()) || (await link.isVisible()), { timeout: 15_000 }).toBe(true);
    if (!(await tip.isVisible())) await link.tap();
    await expect(tip).toBeVisible();
    await expect(tip).toContainText(/Tip 1 of \d+/, { ignoreCase: true });
    // "Next tip" until the last card, which says "Got it".
    for (let step = 0; step < 12; step += 1) {
      const next = screen.getByRole('button', 'Next tip');
      if (!(await next.isVisible())) break;
      await next.tap();
    }
    await screen.getByRole('button', 'Got it').tap();
    await expect(tip).toBeHidden();
    await expect(link).toBeVisible();
  });

  test('at phone width the footer keeps Options and Start on one line', async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open('/new');
    const prompt = screen.getByRole('textbox', PROMPT);
    await prompt.fill('phone width check');
    const start = await screen.getByRole('button', 'Start task').boundingBox();
    const options = await screen.getByRole('button', 'Options').boundingBox();
    expect(Math.abs(start!.y - options!.y)).toBeLessThan(2);
    expect(start!.x + start!.width).toBeLessThanOrEqual(390);
    await screen.getByRole('button', 'Options').tap();
    const panel = await screen.getByRole('dialog', 'Options').boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(390);
  });
});
