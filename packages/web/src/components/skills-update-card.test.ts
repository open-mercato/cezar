import { describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/client'
import type { SkillsUpdateState } from '@open-mercato/cezar-api-client'

import { applySkillsUpdateSettled } from './skills-update-card'

const state = (over: Partial<SkillsUpdateState>): SkillsUpdateState => ({
  status: 'available',
  available: true,
  autoUpdateEnabled: true,
  inherited: true,
  checkedAt: '2026-10-14T22:00:00.000Z',
  updatedAt: null,
  scopes: [],
  needsUpgradeNotes: false,
  ...over,
})

const unreachable = () => new ApiError(0, 'cannot reach the cezar server (/api/v1/workspace/skills-update/apply)')
const wait = () => Promise.resolve()

/** telemetry edd8c83e: the apply POST lost its connection while npx kept running server-side. */
describe('applySkillsUpdateSettled', () => {
  it('follows a dropped apply to the state the server finished with', async () => {
    const finished = state({ status: 'current', available: false, updatedAt: '2026-10-14T22:16:00.000Z' })
    const read = vi
      .fn()
      .mockResolvedValueOnce(state({ status: 'updating' }))
      .mockResolvedValueOnce(finished)
    const apply = vi.fn().mockRejectedValue(unreachable())
    const onDropped = vi.fn()
    await expect(applySkillsUpdateSettled('p', null, { apply, read, wait, onDropped })).resolves.toBe(finished)
    expect(read).toHaveBeenCalledTimes(2)
    expect(onDropped).toHaveBeenCalledExactlyOnceWith('recovered')
  })

  it('follows an apply that a 409 says is already running', async () => {
    const finished = state({ status: 'current', available: false, updatedAt: '2026-10-14T22:16:00.000Z' })
    const read = vi.fn().mockResolvedValue(finished)
    const apply = vi.fn().mockRejectedValue(new ApiError(409, 'another skills update operation is running'))
    const onDropped = vi.fn()
    await expect(applySkillsUpdateSettled('p', null, { apply, read, wait, onDropped })).resolves.toBe(finished)
    expect(onDropped).not.toHaveBeenCalled()
  })

  it('keeps the original error when no apply finished on the server', async () => {
    const error = unreachable()
    const onDropped = vi.fn()
    const read = vi.fn().mockResolvedValue(state({ status: 'available' }))
    await expect(
      applySkillsUpdateSettled('p', null, { apply: vi.fn().mockRejectedValue(error), read, wait, onDropped }),
    ).rejects.toBe(error)
    expect(onDropped).toHaveBeenCalledExactlyOnceWith('not_applied')
  })

  it('keeps the original error when the server stays unreachable', async () => {
    const error = unreachable()
    const onDropped = vi.fn()
    const read = vi.fn().mockRejectedValue(new ApiError(0, 'cannot reach the cezar server'))
    await expect(
      applySkillsUpdateSettled('p', null, { apply: vi.fn().mockRejectedValue(error), read, wait, onDropped }),
    ).rejects.toBe(error)
    expect(onDropped).toHaveBeenCalledExactlyOnceWith('unreachable')
  })

  it('gives up after its deadline while the server still reports updating', async () => {
    const error = unreachable()
    const onDropped = vi.fn()
    let clock = 0
    const read = vi.fn().mockResolvedValue(state({ status: 'updating' }))
    const pace = async (ms: number) => {
      clock += ms
    }
    await expect(
      applySkillsUpdateSettled('p', null, { apply: vi.fn().mockRejectedValue(error), read, wait: pace, now: () => clock, onDropped }),
    ).rejects.toBe(error)
    expect(onDropped).toHaveBeenCalledExactlyOnceWith('timed_out')
  })

  it('does not retry an HTTP failure that is not about reachability', async () => {
    const error = new ApiError(404, 'unknown project: p')
    const read = vi.fn()
    await expect(
      applySkillsUpdateSettled('p', null, { apply: vi.fn().mockRejectedValue(error), read, wait }),
    ).rejects.toBe(error)
    expect(read).not.toHaveBeenCalled()
  })
})
