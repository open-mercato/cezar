import type { TrackerContext } from '@open-mercato/cezar-contract';

export const CONTEXT_DESCRIPTION_LIMIT = 200_000;
const CONTEXT_COMMENTS_LIMIT = 500_000;

/** Lossy or oversized issue content degrades to a named limitation; it never blocks a run. */
export function boundedContext(context: TrackerContext, lossy: { description: boolean; comments: number; pagesExhausted?: boolean }): TrackerContext {
  const limitations = [...context.limitations];
  if (context.item.bodyTruncated) limitations.push(`The description was truncated at ${CONTEXT_DESCRIPTION_LIMIT} characters; open the issue URL if the rest matters.`);
  if (lossy.description) limitations.push('The description contains content rendered approximately or omitted (for example mentions, media, panels or smart links).');
  if (lossy.comments) limitations.push(`${lossy.comments} comment(s) contain content rendered approximately or omitted.`);
  if (lossy.pagesExhausted) limitations.push('Not every comment page could be read; the oldest comments may be missing.');
  // Keep the newest discussion: drop the oldest comments until the budget fits.
  const sizes = context.comments.map(comment => JSON.stringify(comment).length + 1);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  let dropped = 0;
  while (dropped < sizes.length && total > CONTEXT_COMMENTS_LIMIT) total -= sizes[dropped++]!;
  if (dropped) limitations.push(`The ${dropped} oldest comment(s) were omitted to fit the context limit.`);
  return { ...context, comments: context.comments.slice(dropped), limitations };
}
