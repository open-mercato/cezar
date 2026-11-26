import type { WorkflowGraphNode } from '@open-mercato/cezar-api-client'

type GraphNodeType = WorkflowGraphNode['type']

/** Each node type's `{{nodes.<id>.<field>}}` outputs, as the server's `NODE_CATALOG` lists them
 *  (`node-outputs-parity.test.ts` in packages/cezar keeps the two equal). */
export const NODE_OUTPUTS: Record<GraphNodeType, string[]> = {
  start: [],
  end: [],
  loop: ['iteration', 'max'],
  agent: ['summary', 'verdict', 'costUsd'],
  check: ['exitCode', 'output'],
  'gate.human': ['comment'],
  'ask-user': ['answer'],
  dispatch: ['runId', 'status', 'summary'],
  'git.commit': ['sha'],
  'github.draft-pr': ['url', 'number'],
  'github.wait-ci': ['status'],
  'github.pr-comment': [],
  fork: ['runIds'],
  join: ['succeeded', 'failed'],
  workflow: ['runId', 'status', 'summary'],
  if: ['result', 'value'],
  'git.push': [],
  'git.sync-base': ['conflicts'],
  'github.pr-checkout': ['number', 'head', 'tree', 'diff', 'meta', 'checkedOut'],
  'github.pr-update': [],
  'github.issue-comment': ['issue'],
  'notify.webhook': ['status'],
}
