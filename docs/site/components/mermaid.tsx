'use client';
import { useEffect, useId, useState } from 'react';
import { useTheme } from 'next-themes';

/** Renders a Mermaid chart in the browser; the chart source stays readable in the MDX file. */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        fontFamily: 'inherit',
        theme: resolvedTheme === 'dark' ? 'dark' : 'default',
      });
      const { svg } = await mermaid.render(`mermaid-${id}`, chart);
      if (!cancelled) setSvg(svg);
    });
    return () => {
      cancelled = true;
    };
  }, [chart, id, resolvedTheme]);

  if (!svg) {
    return <pre className="not-prose my-6 overflow-x-auto rounded-lg border p-4 text-xs">{chart}</pre>;
  }
  return (
    <div
      className="not-prose my-6 flex justify-center overflow-x-auto rounded-lg border bg-fd-card p-4"
      // securityLevel 'strict' makes Mermaid sanitize labels before this point.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
