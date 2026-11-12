import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';

/** The index the tab renders, from the same route (`tracked + untracked-not-ignored`), so counts
 *  stay exact even after the dry-run auth probe drops its `notes.md` into the checkout. */
async function repoTree(app: { baseUrl?: string }) {
  const { paths } = (await (await fetch(new URL('/api/v1/repo/tree', app.baseUrl))).json()) as { paths: string[] };
  const rootFiles = paths.filter((path) => !path.includes('/'));
  const dirs = [...new Set(paths.filter((path) => path.includes('/')).map((path) => path.split('/')[0]))];
  const under = (dir: string) => paths.filter((path) => path.startsWith(`${dir}/`));
  return { paths, rootFiles, dirs, under };
}

describe('repo-files', { tags: ['repo-files'] }, () => {
  test('the Files tab shows the tracked tree with folders closed and nothing selected', async ({ app, screen, browser }) => {
    const index = await repoTree(app);
    expect(index.dirs).toEqual(['docs', 'src']);
    expect(index.paths).toEqual(expect.arrayContaining(['.gitignore', 'README.md', 'package.json', 'src/greet.ts', 'src/index.ts', 'docs/guide.md']));
    await app.open('/git/files');
    await expect(browser).toHaveURL(/\/p\/[^/]+\/git\/files$/);
    await expect(screen.getByRole('link', 'Files')).toHaveAttribute('aria-current', 'page');
    const tree = screen.getByRole('tree', 'Repository files');
    await expect(tree).toBeVisible();
    await expect(tree.getByRole('treeitem', 'docs')).toHaveAttribute('aria-expanded', 'false');
    await expect(tree.getByRole('treeitem', 'src')).toHaveAttribute('aria-expanded', 'false');
    for (const file of ['.gitignore', 'README.md', 'package.json']) {
      await expect(tree.getByRole('treeitem', file)).toBeVisible();
    }
    await expect(tree.getByRole('treeitem')).toHaveCount(index.dirs.length + index.rootFiles.length);
    await expect(browser.locator('[data-slot="repo-files-count"]')).toHaveText(`${index.paths.length} files`);
    await expect(screen.getByRole('heading', 'Select a file', { level: 2 })).toBeVisible();
  });

  test('expanding src reveals its files and opening greet.ts renders the source', async ({ app, screen, browser }) => {
    await app.open('/git/files');
    const tree = screen.getByRole('tree', 'Repository files');
    await tree.getByRole('treeitem', 'src').tap();
    await expect(tree.getByRole('treeitem', 'src')).toBeExpanded();
    await expect(tree.getByRole('treeitem', 'greet.ts')).toBeVisible();
    await expect(tree.getByRole('treeitem', 'index.ts')).toBeVisible();

    await tree.getByRole('treeitem', 'greet.ts').tap();
    await expect(browser).toHaveURL(/\/git\/files\/src\/greet\.ts$/);
    await expect(tree.getByRole('treeitem', 'greet.ts')).toBeSelected();
    await expect(browser.locator('[data-slot="file-preview-head"]')).toContainText('src/greet.ts');
    await expect(browser.locator('[data-slot="file-preview-code"]')).toContainText('export function greet');
    await expect(screen.getByRole('heading', 'Select a file', { level: 2 })).toHaveCount(0);
  });

  test('a deep link opens with its ancestors expanded and the file selected', async ({ app, screen, browser }) => {
    await app.open('/git/files/src/index.ts');
    const tree = screen.getByRole('tree', 'Repository files');
    await expect(tree.getByRole('treeitem', 'src')).toBeExpanded();
    await expect(tree.getByRole('treeitem', 'index.ts')).toBeSelected();
    await expect(tree.getByRole('treeitem', 'docs')).toHaveAttribute('aria-expanded', 'false');
    await expect(browser.locator('[data-slot="file-preview-code"]')).toContainText('export function main');
    // Selecting a sibling replaces the URL — the file's own address.
    await tree.getByRole('treeitem', 'greet.ts').tap();
    await expect(browser).toHaveURL(/\/git\/files\/src\/greet\.ts$/);
    await expect(browser.locator('[data-slot="file-preview-head"]')).toContainText('src/greet.ts');
  });

  test('a Markdown file renders by default and can be flipped to its source', async ({ app, screen, browser }) => {
    await app.open('/git/files/docs/guide.md');
    const tree = screen.getByRole('tree', 'Repository files');
    await expect(tree.getByRole('treeitem', 'docs')).toBeExpanded();
    await expect(tree.getByRole('treeitem', 'guide.md')).toBeSelected();
    await expect(browser.locator('[data-slot="file-preview-markdown"]').getByRole('heading', 'Guide')).toBeVisible();
    const source = browser.locator('[data-slot="markdown-view-toggle"] [data-mode="source"]');
    await source.tap();
    await expect(source).toHaveAttribute('aria-pressed', 'true');
    await expect(browser.locator('[data-slot="file-preview-code"]')).toContainText('# Guide');
    await browser.locator('[data-slot="markdown-view-toggle"] [data-mode="rendered"]').tap();
    await expect(browser.locator('[data-slot="file-preview-markdown"]').getByRole('heading', 'Guide')).toBeVisible();
  });

  test('the filter flattens matches to full paths and Escape clears it', async ({ app, screen, browser }) => {
    const index = await repoTree(app);
    await app.open('/git/files');
    const tree = screen.getByRole('tree', 'Repository files');
    const filter = screen.getByLabel('Filter repository files');
    await filter.fill('greet');
    await expect(tree.getByRole('treeitem')).toHaveCount(1);
    await expect(tree.getByRole('treeitem', 'src/greet.ts')).toBeVisible();
    await expect(browser.locator('[data-slot="repo-files-count"]')).toHaveText('1 files match greet');
    await tree.getByRole('treeitem', 'src/greet.ts').tap();
    await expect(browser).toHaveURL(/\/git\/files\/src\/greet\.ts$/);

    await filter.fill('nothing-here');
    await expect(screen.getByText('No file matches nothing-here.')).toBeVisible();
    await filter.press('Escape');
    await expect(filter).toHaveValue('');
    // src stays open after the pick: every folder, the files under src, and the root files.
    await expect(tree.getByRole('treeitem')).toHaveCount(index.dirs.length + index.under('src').length + index.rootFiles.length);
  });

  test('the tree answers the keyboard: / focuses the filter, arrows open folders, Enter opens a file', async ({ app, screen, browser }) => {
    await app.open('/git/files');
    const tree = screen.getByRole('tree', 'Repository files');
    const docs = tree.getByRole('treeitem', 'docs');
    await docs.focus();
    await expect(docs).toBeFocused();
    await docs.press('/');
    await expect(screen.getByLabel('Filter repository files')).toBeFocused();

    await docs.focus();
    await docs.press('ArrowRight');
    await expect(docs).toBeExpanded();
    await expect(tree.getByRole('treeitem', 'guide.md')).toBeVisible();
    await docs.press('ArrowDown');
    await docs.press('Enter');
    await expect(browser).toHaveURL(/\/git\/files\/docs\/guide\.md$/);
    await expect(tree.getByRole('treeitem', 'guide.md')).toBeSelected();
  });

  test('a path outside the index renders the refusal in the server’s words', async ({ app, screen }) => {
    await app.open('/git/files/nope.ts');
    await expect(screen.getByRole('heading', 'Cannot preview this file', { level: 2 })).toBeVisible();
    await expect(screen.getByText('not in the repository index', { exact: false })).toBeVisible();
    // The tree is still there to pick a real file from.
    await expect(screen.getByRole('tree', 'Repository files')).toBeVisible();
  });

  test('on a phone the tree is the view until a file is picked, and Back returns to it', async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open('/git/files');
    const tree = screen.getByRole('tree', 'Repository files');
    await expect(tree).toBeVisible();
    await expect(screen.getByRole('heading', 'Select a file', { level: 2 })).toBeHidden();

    await tree.getByRole('treeitem', 'README.md').tap();
    await expect(browser).toHaveURL(/\/git\/files\/README\.md$/);
    await expect(tree).toBeHidden();
    await expect(browser.locator('[data-slot="file-preview-markdown"]').getByRole('heading', 'Fixture app')).toBeVisible();

    await screen.getByRole('button', 'Back to the file tree').tap();
    await expect(browser).toHaveURL(/\/git\/files$/);
    await expect(tree).toBeVisible();
    await browser.setViewport({ width: 1280, height: 800 });
  });
});
