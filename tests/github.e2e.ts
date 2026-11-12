import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { githubDataSchema, type GithubData } from '@open-mercato/cezar-contract';

/** The list call: `/api/v1/p/<id>/github?limit=…` (the checks/comments/search siblings have a
 *  path segment after `github`, so they stay on the real server). */
const LIST_URL = /\/api\/v1\/(?:p\/[^/]+\/)?github\?/;

/** What the server answers when `gh` or a GitHub remote is missing — the honest degrade of
 *  `githubDataSchema`, never an error. `CEZ_DRY_RUN=1` serves a mock catalog instead, so the
 *  degraded state is stubbed here. */
const UNAVAILABLE: GithubData = githubDataSchema.parse({
  available: false,
  reason: 'gh CLI not found — install it and run `gh auth login`',
  issues: [],
  prs: [],
});

/** One issue carrying every linked-PR state the row chips tint by. */
const LINKED_PRS: GithubData = githubDataSchema.parse({
  available: true,
  repo: 'e2e/fixture',
  syncedAt: new Date().toISOString(),
  issues: [
    {
      kind: 'issue',
      number: 3,
      title: 'Greeting should also say goodbye',
      author: 'e2e',
      createdAt: new Date().toISOString(),
      labels: [],
      url: 'https://github.com/e2e/fixture/issues/3',
      comments: 0,
      assignees: [],
      linkedPrs: [
        { number: 7, title: 'Add a farewell helper', url: 'https://github.com/e2e/fixture/pull/7', state: 'merged', isDraft: false },
        { number: 8, title: 'Trim the greeting name', url: 'https://github.com/e2e/fixture/pull/8', state: 'open', isDraft: false },
        { number: 9, title: 'Wrap the entry point', url: 'https://github.com/e2e/fixture/pull/9', state: 'open', isDraft: true },
      ],
    },
  ],
  prs: [],
  issuesTotal: 1,
  prsTotal: 0,
  issuesNextCursor: null,
  prsNextCursor: null,
});

describe('github', { tags: ['github'] }, () => {
  test('without gh or a remote the list URLs render the unavailable explainer, never an error', async ({ app, screen, browser }) => {
    await browser.route(LIST_URL, (route) => route.fulfill({ json: UNAVAILABLE }));
    for (const path of ['/github', '/github/prs']) {
      await app.open(path);
      await expect(browser).toHaveURL(/\/p\/[^/]+\/github(?:\/prs)?$/);
      await expect(screen.getByRole('heading', 'GitHub is unavailable here', { level: 1 })).toBeVisible();
      await expect(screen.getByText(UNAVAILABLE.reason!)).toBeVisible();
      await expect(screen.getByText('gh auth login')).toBeVisible();
      await expect(screen.getByRole('button', 'Try again')).toBeEnabled();
    }
  });

  test('a pasted deep link degrades the same way, and Try again keeps the state honest', async ({ app, screen, browser }) => {
    await browser.route(LIST_URL, (route) => route.fulfill({ json: UNAVAILABLE }));
    for (const path of ['/github/prs/128', '/github/issues/142']) {
      await app.open(path);
      await expect(screen.getByRole('heading', 'GitHub is unavailable here', { level: 1 })).toBeVisible();
      await expect(screen.getByText(UNAVAILABLE.reason!)).toBeVisible();
    }
    await screen.getByRole('button', 'Try again').tap();
    await expect(screen.getByRole('heading', 'GitHub is unavailable here', { level: 1 })).toBeVisible();
    await expect(screen.getByRole('button', 'Try again')).toBeEnabled();
  });

  test('the pull-request list shows the catalog with counts, labels and checks', async ({ app, screen, browser }) => {
    await app.open('/github/prs');
    await expect(browser).toHaveURL(/\/p\/[^/]+\/github\/prs$/);
    await expect(screen.getByRole('heading', 'GitHub', { level: 1 })).toBeVisible();
    await expect(browser.locator('[data-slot="gh-repo"]')).toHaveText('mock/repo');
    await expect(screen.getByRole('link', 'Issues · 3')).toBeVisible();
    await expect(screen.getByRole('link', 'Pull requests · 2')).toHaveAttribute('aria-current', 'page');

    const rows = browser.locator('[data-slot="gh-row"]');
    await expect(rows).toHaveCount(2);
    await expect(rows).toContainText(['Fix flaky auth test in CI', 'Rate limit /api/runs']);
    await expect(rows.filter({ hasText: 'Fix flaky auth test in CI' })).toContainText('#128');
    await expect(browser.locator('[data-slot="gh-row"][data-number="128"] [data-slot="gh-label"][data-label="tests"]')).toBeVisible();
    await expect(browser.locator('[data-slot="gh-row"][data-number="124"] [data-slot="gh-label"][data-label="draft"]')).toBeVisible();
    await expect(browser.locator('[data-slot="gh-row"][data-number="128"] [aria-label="checks passing"]')).toBeAttached();
    await expect(browser.locator('[data-slot="gh-row"][data-number="124"] [aria-label="checks failing"]')).toBeAttached();
    // No `:n` on a populated list: the detail pane falls back to the newest open item.
    await expect(browser.locator('[data-slot="gh-detail-inner"]').getByRole('heading', 'Fix flaky auth test in CI', { level: 2 })).toBeVisible();
    await expect(screen.getByRole('link', 'Fix flaky auth test in CI', { exact: false })).toHaveAttribute('aria-current', 'page');
  });

  test('opening a pull request shows its detail and the Changes sub-route', async ({ app, screen, browser }) => {
    await app.open('/github/prs');
    await screen.getByRole('link', 'Fix flaky auth test in CI', { exact: false }).tap();
    await expect(browser).toHaveURL(/\/github\/prs\/128$/);
    await expect(screen.getByRole('heading', 'Fix flaky auth test in CI', { level: 2 })).toBeVisible();
    const meta = browser.locator('[data-slot="gh-meta"]');
    await expect(meta).toContainText('#128');
    await expect(meta).toContainText('pull request');
    await expect(meta).toContainText('opened by mock');
    await expect(meta.getByRole('link', 'open on GitHub')).toHaveAttribute('href', 'https://github.com/mock/repo/pull/128');
    const detailNav = screen.getByRole('navigation', 'Pull request detail');
    await expect(detailNav.getByRole('link', 'Conversation')).toHaveAttribute('aria-current', 'page');
    await expect(browser.locator('[data-slot="gh-detail-inner"] [data-slot="gh-label"][data-label="tests"]')).toBeVisible();
    // The thread hydrates the body from the detail endpoint (dry-run: the mock thread).
    await expect(browser.locator('[data-slot="gh-body"]')).toContainText('Mock pull request body.');
    await expect(screen.getByText('Looks good overall — please add a regression test before this lands.')).toBeVisible();

    await detailNav.getByRole('link', 'Changes').tap();
    await expect(browser).toHaveURL(/\/github\/prs\/128\/changes$/);
    await expect(detailNav.getByRole('link', 'Changes')).toHaveAttribute('aria-current', 'page');
    const changes = browser.locator('[data-slot="gh-pr-changes"]');
    await expect(changes).toContainText('4 changed files');
    await expect(changes).toContainText('+15');
    await expect(changes).toContainText('−4');
    await expect(changes.getByRole('status')).toContainText('One or more patches were not provided by GitHub.');
    await expect(changes.getByRole('link', 'Open all files on GitHub')).toHaveAttribute('href', 'https://github.com/mock/repo/pull/128/files');
    await expect(changes.getByLabel('Filter changed files')).toBeVisible();
  });

  test('a number outside the open list renders Not found with the search advice', async ({ app, screen }) => {
    await app.open('/github/prs/999');
    await expect(screen.getByRole('heading', 'Not found', { level: 2 })).toBeVisible();
    await expect(screen.getByText('#999 is not among the open pull requests', { exact: false })).toBeVisible();
    await expect(screen.getByRole('link', 'Pull requests · 2')).toHaveAttribute('aria-current', 'page');
  });

  test('the search box narrows the open list', async ({ app, screen, browser }) => {
    await app.open('/github/prs');
    const rows = browser.locator('[data-slot="gh-row"]');
    await expect(rows).toHaveCount(2);
    await screen.getByLabel('Search prs').fill('Rate limit');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('Rate limit /api/runs');
    await screen.getByLabel('Search prs').fill('#128');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('Fix flaky auth test in CI');
  });

  test('issue rows carry their assignees and linked pull requests, tinted by state', async ({ app, screen, browser }) => {
    await app.open('/github');
    await expect(screen.getByRole('link', 'Issues · 3')).toHaveAttribute('aria-current', 'page');
    const ownership = screen.getByRole('group', 'Issue #142 ownership');
    await expect(ownership).toContainText('Assigned to @ada, @grace');
    const open = ownership.getByRole('link', 'PR #128 · Open: Fix the session refresh');
    await expect(open).toHaveAttribute('href', 'https://github.com/mock/repo/pull/128');
    // Linked PRs wear the reference chips' tones: open waits on a person (blue), merged is the outcome (green).
    await expect(browser).toHaveClass(open, /text-info/);
    const merged = screen.getByRole('group', 'Issue #139 ownership').getByRole('link', 'PR #126 · Merged: Add JSON output');
    await expect(browser).toHaveClass(merged, /text-success/);
  });

  test('a stubbed issue paints merged, open and draft linked PRs with distinct tones', async ({ app, screen, browser }) => {
    await browser.route(LIST_URL, (route) => route.fulfill({ json: LINKED_PRS }));
    await app.open('/github');
    await expect(browser.locator('[data-slot="gh-repo"]')).toHaveText('e2e/fixture');
    await expect(screen.getByRole('link', 'Issues · 1')).toBeVisible();
    const ownership = screen.getByRole('group', 'Issue #3 ownership');
    await expect(ownership).toContainText('Unassigned');
    const merged = ownership.getByRole('link', 'PR #7 · Merged: Add a farewell helper');
    const open = ownership.getByRole('link', 'PR #8 · Open: Trim the greeting name');
    const draft = ownership.getByRole('link', 'PR #9 · Draft: Wrap the entry point');
    await expect(browser).toHaveClass(merged, /text-success/);
    await expect(browser).toHaveClass(open, /text-info/);
    await expect(browser).not.toHaveClass(draft, /text-(?:violet|success|info)/);
    // Violet is the running pulse, never a chip at rest.
    await expect(browser).not.toHaveClass(merged, /text-violet/);
  });

  test('on a phone the list and the detail are one surface at a time', async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open('/github/prs');
    const list = browser.locator('[data-slot="gh-list"]');
    const detail = browser.locator('[data-slot="gh-detail"]');
    await expect(list).toBeVisible();
    await expect(detail).toBeHidden();
    await screen.getByRole('link', 'Rate limit /api/runs', { exact: false }).tap();
    await expect(browser).toHaveURL(/\/github\/prs\/124$/);
    await expect(detail).toBeVisible();
    await expect(list).toBeHidden();
    await expect(screen.getByRole('heading', 'Rate limit /api/runs', { level: 2 })).toBeVisible();
    await screen.getByRole('link', 'Back to the list').tap();
    await expect(browser).toHaveURL(/\/github\/prs$/);
    await expect(list).toBeVisible();
    await browser.setViewport({ width: 1280, height: 800 });
  });
});
