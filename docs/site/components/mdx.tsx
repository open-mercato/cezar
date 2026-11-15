import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Callout } from 'fumadocs-ui/components/callout';
import type { MDXComponents } from 'mdx/types';
import { Mermaid } from './mermaid';

// Every component a page may use. Adding one also means documenting it in
// content/docs/05-contributing/01-docs-contribution-guide.mdx ("Custom components").
export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Mermaid,
    // Notes are written as `> **Good to know**:` blockquotes (Next.js style) and shown as callouts.
    blockquote: (props) => <Callout>{props.children}</Callout>,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
