import { describe, expect, it } from 'vitest'

import { taskReviewPrNumber } from './task-review-pr'

describe('taskReviewPrNumber', () => {
  it('prefers the PR the task opened', () => {
    expect(taskReviewPrNumber({ pullRequestUrl: 'https://github.com/o/r/pull/12', markerRefs: { pr: 9 } })).toBe(12)
  })
  it('falls back to the declared PR', () => {
    expect(taskReviewPrNumber({ markerRefs: { pr: 9 } })).toBe(9)
  })
  it('is undefined without either, or for a forge URL with no number', () => {
    expect(taskReviewPrNumber({})).toBeUndefined()
    expect(taskReviewPrNumber({ pullRequestUrl: 'https://forge.example/merge-requests/new' })).toBeUndefined()
  })
})
