import { z } from 'zod';
import type { GithubItem } from '@open-mercato/cezar-contract';
import type { GraphqlRunner } from './github.ts';

const BATCH_SIZE = 50;
const CONNECTION_LIMIT = 10;
const MAX_ISSUES = 1000;
const pageInfoSchema = z.object({ hasNextPage: z.boolean() });
const metadataSchema = z.object({
  number: z.number().int().positive(),
  assignees: z.object({
    nodes: z.array(z.object({ login: z.string() }).nullable()).max(CONNECTION_LIMIT),
    pageInfo: pageInfoSchema,
  }).nullish(),
  closedByPullRequestsReferences: z.object({
    nodes: z.array(z.object({
      number: z.number().int().positive(),
      title: z.string(),
      url: z.string().url(),
      state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
      isDraft: z.boolean(),
    }).nullable()).max(CONNECTION_LIMIT),
    pageInfo: pageInfoSchema,
  }).nullish(),
});
const responseSchema = z.object({
  data: z.object({ repository: z.record(z.string(), z.unknown()).nullable() }).nullish(),
});
type IssueMetadata = Pick<GithubItem, 'assignees' | 'assigneesTruncated' | 'linkedPrs' | 'linkedPrsTruncated'>;

/** A bounded batch, not one process per row. A failed optional read cannot hide usable issues. */
export async function fetchIssueMetadata(
  runGraphql: GraphqlRunner,
  owner: string,
  name: string,
  numbers: number[],
): Promise<Map<number, IssueMetadata>> {
  const requested = [...new Set(numbers.filter(number => Number.isSafeInteger(number) && number > 0))].slice(0, MAX_ISSUES);
  const result = new Map<number, IssueMetadata>();
  for (let offset = 0; offset < requested.length; offset += BATCH_SIZE) {
    const batch = requested.slice(offset, offset + BATCH_SIZE);
    // Only validated integers enter the query; repository names stay in GraphQL variables.
    const fields = batch.map(number => `issue${number}: issue(number: ${number}) {
      number
      assignees(first: ${CONNECTION_LIMIT}) { nodes { login } pageInfo { hasNextPage } }
      closedByPullRequestsReferences(first: ${CONNECTION_LIMIT}, includeClosedPrs: true, orderByState: true) {
        nodes { number title url state isDraft } pageInfo { hasNextPage }
      }
    }`).join('\n');
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
    try {
      const repository = responseSchema.parse(JSON.parse(await runGraphql(query, { owner, name }))).data?.repository;
      for (const number of batch) {
        const parsed = metadataSchema.safeParse(repository?.[`issue${number}`]);
        if (!parsed.success || parsed.data.number !== number) continue;
        const { assignees, closedByPullRequestsReferences: prs } = parsed.data;
        result.set(number, {
          ...(assignees && assignees.nodes.every(user => user !== null) ? {
            assignees: assignees.nodes.flatMap(user => user ? [user.login] : []),
            ...(assignees.pageInfo.hasNextPage ? { assigneesTruncated: true } : {}),
          } : {}),
          ...(prs && prs.nodes.every(pr => pr !== null) ? {
            linkedPrs: prs.nodes.flatMap(pr => pr ? [{ ...pr, state: pr.state === 'OPEN' ? 'open' as const : pr.state === 'MERGED' ? 'merged' as const : 'closed' as const }] : []),
            ...(prs.pageInfo.hasNextPage ? { linkedPrsTruncated: true } : {}),
          } : {}),
        });
      }
    } catch {
      // Older GitHub hosts, missing scopes and offline reads keep this batch's metadata unknown.
    }
  }
  return result;
}
