import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';

// The fixture's `main` log, newest first (scripts/e2e-fixture-repo.mjs); "Add a farewell helper"
// lives on `feature/farewell` only.
const MAIN_SUBJECTS = ['Wrap the entry point in main()', 'Trim the greeting name and add a guide', 'Initial fixture app'];

// Serial: the switch test checks a branch out on the shared fixture repo, and a parallel reader
// would see the other branch's log.
describe('repo-git', { tags: ['repo-git'], serial: true }, () => {
  test('the Git overview shows the checked-out branch and a clean working tree', async ({ app, screen, browser }) => {
    await app.open('/git');
    await expect(browser).toHaveURL(/\/p\/[^/]+\/git$/);
    await expect(screen.getByRole('heading', 'Git', { level: 1 })).toBeVisible();
    await expect(browser.locator('[data-slot="branch-chip"]')).toHaveText('main');
    await expect(browser.locator('[data-slot="repo-upstream"]')).toHaveText('not published');
    await expect(screen.getByRole('button', 'Fetch')).toBeDisabled();
    for (const tab of ['Changes', 'Commits', 'Branches', 'Files']) {
      await expect(screen.getByRole('link', tab)).toBeVisible();
    }
    await expect(screen.getByRole('link', 'Changes')).toHaveAttribute('aria-current', 'page');
    await expect(screen.getByText('Uncommitted changes')).toBeVisible();
    // The fixture is committed clean, but the server's auth-probe warm-up makes the dry-run mock
    // append a `notes.md` to the checkout a few seconds after boot (see the suite report). The
    // UI must mirror git either way; anything else in the tree is a real failure.
    const changes = (await (await fetch(new URL('/api/v1/repo/changes', app.baseUrl))).json()) as { files: { path: string }[] };
    const paths = changes.files.map((file) => file.path);
    expect(paths.filter((path) => path !== 'notes.md'), 'unexpected working-tree changes').toEqual([]);
    if (paths.length === 0) {
      await expect(screen.getByRole('heading', 'Working tree clean', { level: 2 })).toBeVisible();
    } else {
      await expect(browser.locator('[data-slot="changes-tree-pane"]')).toContainText('notes.md');
      await expect(browser.locator('[data-slot="diff-file"]')).toHaveCount(1);
    }
  });

  test('the Commits tab lists the main log with subject and author', async ({ app, screen, browser }) => {
    await app.open('/git/commits');
    await expect(browser).toHaveURL(/\/git\/commits$/);
    await expect(screen.getByRole('link', 'Commits')).toHaveAttribute('aria-current', 'page');
    const rows = browser.locator('[data-slot="commit-row"]');
    await expect(rows).toHaveCount(3);
    await expect(rows).toContainText(MAIN_SUBJECTS);
    for (const subject of MAIN_SUBJECTS) {
      await expect(screen.getByRole('link', subject, { exact: false })).toContainText('E2E Fixture');
    }
    await expect(screen.getByText('Add a farewell helper')).toHaveCount(0);
  });

  test('opening a commit shows its subject, author and per-file diff', async ({ app, screen, browser }) => {
    await app.open('/git/commits');
    await screen.getByRole('link', 'Trim the greeting name and add a guide', { exact: false }).tap();
    await expect(browser).toHaveURL(/\/git\/commits\/[0-9a-f]{7,40}$/);
    await expect(screen.getByRole('heading', 'Trim the greeting name and add a guide', { level: 2 })).toBeVisible();
    await expect(browser.locator('[data-slot="commit-meta"]')).toContainText('E2E Fixture');
    const files = browser.locator('[data-slot="diff-file"]');
    await expect(files).toHaveCount(2);
    await expect(browser.locator('[data-slot="diff-file-path"]')).toContainText(['docs/guide.md', 'src/greet.ts']);
    await expect(files.filter({ hasText: 'src/greet.ts' })).toContainText('name.trim()');
    await screen.getByRole('link', 'All commits').tap();
    await expect(browser).toHaveURL(/\/git\/commits$/);
    await expect(browser.locator('[data-slot="commit-row"]')).toHaveCount(3);
  });

  test('an unknown commit sha renders the not-found state, not an error', async ({ app, screen }) => {
    await app.open('/git/commits/0000000');
    await expect(screen.getByRole('heading', 'Commit not found', { level: 2 })).toBeVisible();
    await expect(screen.getByRole('link', 'All commits')).toBeVisible();
  });

  test('the Branches tab lists both branches, marks the current one and filters', async ({ app, screen, browser }) => {
    await app.open('/git/branches');
    await expect(browser).toHaveURL(/\/git\/branches$/);
    await expect(screen.getByRole('heading', 'Branches', { level: 2 })).toBeVisible();
    const rows = browser.locator('[data-slot="branch-row"]');
    await expect(rows).toHaveCount(2);
    const main = browser.locator('[data-slot="branch-row"][data-branch="main"]');
    const feature = browser.locator('[data-slot="branch-row"][data-branch="feature/farewell"]');
    await expect(main).toContainText('current');
    await expect(main.getByRole('button', 'Switch')).toHaveCount(0);
    await expect(feature).not.toContainText('current');
    await expect(feature.getByRole('button', 'Switch')).toBeVisible();

    const filter = screen.getByLabel('Filter branches');
    await filter.fill('fare');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('feature/farewell');
    await filter.fill('zzz');
    await expect(screen.getByText('No branches match “zzz”.')).toBeVisible();
    await filter.clear();
    await expect(rows).toHaveCount(2);
  });

  test('the base-branch picker offers every branch and closes without a change', async ({ app, screen, browser }) => {
    await app.open('/git/branches');
    const picker = screen.getByRole('combobox', 'Agents’ base branch');
    await expect(picker).toContainText('follow checked-out branch (default)');
    await picker.tap();
    await expect(screen.getByRole('option', 'main')).toBeVisible();
    await expect(screen.getByRole('option', 'feature/farewell')).toBeVisible();
    await browser.keyboard.press('Escape');
    await expect(screen.getByRole('listbox')).toBeHidden();
    await expect(picker).toContainText('follow checked-out branch (default)');
  });

  test('switching to feature/farewell and back moves the current marker', async ({ app, screen, browser }) => {
    await app.open('/git/branches');
    const chip = browser.locator('[data-slot="branch-chip"]');
    const main = browser.locator('[data-slot="branch-row"][data-branch="main"]');
    const feature = browser.locator('[data-slot="branch-row"][data-branch="feature/farewell"]');

    await feature.getByRole('button', 'Switch').tap();
    await expect(screen.getByText('Switched to feature/farewell')).toBeVisible();
    await expect(feature).toContainText('current');
    await expect(chip).toHaveText('feature/farewell');
    await expect(main.getByRole('button', 'Switch')).toBeVisible();

    // Back to main so the rest of the suite sees the fixture as built.
    await main.getByRole('button', 'Switch').tap();
    await expect(screen.getByText('Switched to main')).toBeVisible();
    await expect(main).toContainText('current');
    await expect(chip).toHaveText('main');
  });

  test('on a phone the tabs stay, the diff toggles and the author column fold away', async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open('/git/commits');
    await expect(screen.getByRole('heading', 'Git', { level: 1 })).toBeVisible();
    for (const tab of ['Changes', 'Commits', 'Branches', 'Files']) {
      await expect(screen.getByRole('link', tab)).toBeVisible();
    }
    const row = screen.getByRole('link', 'Initial fixture app', { exact: false });
    await expect(row).toBeVisible();
    await expect(row).not.toContainText('E2E Fixture');
    await row.tap();
    await expect(screen.getByRole('heading', 'Initial fixture app', { level: 2 })).toBeVisible();
    await expect(screen.getByRole('button', 'Wrap long lines')).toBeHidden();
    await expect(browser.locator('[data-slot="diff-file"]')).toHaveCount(5);
    await browser.setViewport({ width: 1280, height: 800 });
  });
});
