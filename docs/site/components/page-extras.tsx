import { Card, Cards } from 'fumadocs-ui/components/card';
import { source } from '@/lib/source';
import { githubBlobUrl } from '@/lib/shared';
import type { DocsVersion, Related, SourceRef } from '@/lib/schema';

const VERSIONS: Record<NonNullable<DocsVersion>, { label: string; hint: string; className: string }> = {
  'opt-in': {
    label: 'Opt-in',
    hint: 'Off by default. This page explains how to turn it on.',
    className: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  },
  experimental: {
    label: 'Experimental',
    hint: 'Its behavior can change between releases.',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  planned: {
    label: 'Planned',
    hint: 'Described in a specification. You cannot use it yet.',
    className: 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300',
  },
};

export function VersionBadge({ version }: { version: DocsVersion }) {
  if (!version) return null;
  const info = VERSIONS[version];
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-fd-muted-foreground">
      <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${info.className}`}>
        {info.label}
      </span>
      {info.hint}
    </p>
  );
}

export function RelatedLinks({ related }: { related?: Related }) {
  if (!related) return null;
  return (
    <section>
      <h2>{related.title ?? 'Next steps'}</h2>
      {related.description ? <p>{related.description}</p> : null}
      <Cards>
        {related.links.map((link) => {
          const page = source.getPage(link.split('/'));
          // Fails the build, so a renamed page cannot leave a dead card behind.
          if (!page) throw new Error(`Unknown related link: ${link}`);
          return (
            <Card key={link} href={page.url} title={page.data.title}>
              {page.data.description}
            </Card>
          );
        })}
      </Cards>
    </section>
  );
}

export function SourceLinks({ sources }: { sources?: SourceRef[] }) {
  if (!sources?.length) return null;
  return (
    <section className="mt-12 border-t pt-2 text-sm">
      <h2>Sources</h2>
      <p className="text-fd-muted-foreground">
        This page was checked against these files. The links open the reviewed commit, which can be
        newer than the release you have installed.
      </p>
      <ul>
        {sources.map((ref) => (
          <li key={`${ref.label}:${ref.path}:${ref.line ?? ''}`}>
            <a href={githubBlobUrl(ref.path, ref.commit, ref.line)} target="_blank" rel="noopener noreferrer">
              {ref.label}
            </a>
            : <code>{ref.line ? `${ref.path}:${ref.line}` : ref.path}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}
