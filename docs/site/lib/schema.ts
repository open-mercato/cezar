import { z } from 'zod';
import { pageSchema } from 'fumadocs-core/source/schema';

// Frontmatter contract for every page. Field names follow the Next.js docs
// (`title`, `description`, `nav_title`, `version`, `related`); `sources` is Cezar's own.
// The writing rules live in content/docs/05-contributing/01-docs-contribution-guide.mdx.
export const sourceRefSchema = z.object({
  label: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .optional(),
});

export const relatedSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  links: z.array(z.string().regex(/^[a-z0-9-]+(\/[a-z0-9-]+)*$/)).min(1),
});

export const docsPageSchema = pageSchema.extend({
  description: z.string().min(1),
  nav_title: z.string().min(1).optional(),
  version: z.enum(['opt-in', 'experimental', 'planned']).optional(),
  related: relatedSchema.optional(),
  sources: z.array(sourceRefSchema).optional(),
});

export type DocsVersion = z.infer<typeof docsPageSchema>['version'];
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type Related = z.infer<typeof relatedSchema>;
