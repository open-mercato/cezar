import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'Cezar';
export const docsRoute = '/docs';
export const docsContentRoute = '/llms.mdx/docs';
/** Where the MDX files live, relative to the repository root. */
export const contentDir = 'docs/site/content/docs';

export const gitConfig = {
  user: 'open-mercato',
  repo: 'cezar',
  branch: 'main',
};

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getContentUrl(segments, page.locale) };
}

/** A GitHub link to a repository file, pinned to the commit a page was checked against. */
export function githubBlobUrl(path: string, commit = gitConfig.branch, line?: number) {
  return `https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${commit}/${path}${line ? `#L${line}` : ''}`;
}
