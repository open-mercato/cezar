import { describe, expect, it } from 'vitest'
import { reduceThread } from './thread-state'
import type { RunEvent } from '@open-mercato/cezar-api-client'

const line = (seq: number, type: string, extra: Record<string, unknown> = {}): RunEvent =>
  ({ seq, ts: `2026-07-17T10:00:0${seq}.000Z`, type, ...extra }) as RunEvent

const OPTIONS = [
  { id: 'allow_once', label: 'Allow once', kind: 'allow_once' as const },
  { id: 'reject_once', label: 'Reject once', kind: 'reject_once' as const },
]

describe('reduceThread — permission cards (#475)', () => {
  it('permission.requested → unresolved permission entry', () => {
    const perm = reduceThread([
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'permission.requested', {
        requestId: 'req_1',
        title: 'Bash · npm test',
        options: OPTIONS,
      }),
    ])
      .turns[0]!.items.find((i) => i.kind === 'permission')
    expect(perm).toMatchObject({
      kind: 'permission',
      id: 'req_1',
      title: 'Bash · npm test',
      resolved: false,
    })
  })

  it('permission.resolved collapses the card', () => {
    const perm = reduceThread([
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'permission.requested', {
        requestId: 'req_1',
        title: 'Bash · npm test',
        options: OPTIONS,
      }),
      line(3, 'permission.resolved', { requestId: 'req_1', optionId: 'allow_once' }),
    ])
      .turns[0]!.items.find((i) => i.kind === 'permission')
    expect(perm).toMatchObject({
      resolved: true,
      optionId: 'allow_once',
    })
  })

  it('permission.resolved cancelled marks cancelled', () => {
    const perm = reduceThread([
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'permission.requested', {
        requestId: 'req_1',
        title: 'Bash · ls',
        options: OPTIONS,
      }),
      line(3, 'permission.resolved', { requestId: 'req_1', cancelled: true }),
    ])
      .turns[0]!.items.find((i) => i.kind === 'permission')
    expect(perm).toMatchObject({ resolved: true, cancelled: true })
  })
})
