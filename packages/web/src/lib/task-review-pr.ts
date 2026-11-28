import type { ApiRun } from '@open-mercato/cezar-api-client'

import { prNumber } from './tasks-table'

/**
 * The PR whose GitHub review comments belong on this task's Changes diff: the PR the task opened,
 * else the one it declared with `CEZ:PR`. A PR it merely references (one it reviewed, one named in
 * the transcript) is not this diff's, so its line numbers would land on the wrong code.
 */
export function taskReviewPrNumber(run: Pick<ApiRun, 'pullRequestUrl' | 'markerRefs'>): number | undefined {
  const created = run.pullRequestUrl ? Number(prNumber(run.pullRequestUrl)) : NaN
  if (Number.isInteger(created) && created > 0) return created
  const declared = run.markerRefs?.pr
  return declared !== undefined && Number.isInteger(declared) && declared > 0 ? declared : undefined
}
