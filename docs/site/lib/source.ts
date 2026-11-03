import { llms, loader } from 'fumadocs-core/source';
import { defineDocs } from 'fumadocs-mdx/macro';
import { metaSchema } from 'fumadocs-core/source/schema';
import { docsRoute } from './shared';
import { docsPageSchema } from './schema';

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: docsPageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

/** `01-getting-started/02-first-task.mdx` → `getting-started/first-task`: the prefix orders, it never shows. */
export const stripOrderPrefix = (segment: string) => segment.replace(/^\d{2}-/, '');

export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  slugs: (_file, next) => next().map(stripOrderPrefix),
  pageTree: {
    transformers: [
      {
        // `nav_title` shortens a long title in the sidebar only.
        file(node, filePath) {
          if (!filePath) return node;
          const file = this.storage.read(filePath);
          const navTitle =
            file?.format === 'page' ? (file.data as { nav_title?: string }).nav_title : undefined;
          return navTitle ? { ...node, name: navTitle } : node;
        },
      },
    ],
  },
});

export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${await page.data.getText('processed')}`,
});
