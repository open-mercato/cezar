import { describe, expect, it } from 'vitest'
import { managerFixture } from './manager-fixtures'
import { managerMascotActivity, mascotReaction } from './mascot-state'
import { blendPose, mascotPose } from './mascot-motion'
import type { ManagerMessage } from '@open-mercato/cezar-api-client'
const reply: ManagerMessage = { kind: 'assistant', id: 'm', seq: 1, at: '', text: '', streaming: true, commands: [], turn: 'chat' }
describe('mascot activity reflects manager evidence', () => {
 it('prioritizes errors and decisions over decorative activity', () => {
  expect(managerMascotActivity(managerFixture({ status: 'error', pendingQuestions: 1 }), [])).toBe('error')
  expect(managerMascotActivity(managerFixture({ status: 'working', pendingActions: 1 }), [reply])).toBe('waiting')
 })
 it('distinguishes starting, presenting and tools without inventing backend states', () => {
  const manager = managerFixture({ status: 'working' })
  expect(managerMascotActivity(manager, [])).toBe('thinking')
  expect(managerMascotActivity(manager, [{ ...reply, text: 'Here is the plan' }])).toBe('present')
  expect(managerMascotActivity(manager, [{ ...reply, commands: [{ id: 't', tool: 'Bash', summary: 'test' }] }])).toBe('working')
  expect(managerMascotActivity(managerFixture({ status: 'idle' }), [{ ...reply, streaming: false }])).toBe('idle')
 })
 it('does not celebrate a normal response or replay an existing important message', () => {
  expect(mascotReaction(reply, { ...reply, streaming: false })).toBeUndefined()
  const important = { ...reply, important: true }
  expect(mascotReaction(reply, important)).toBe('alert')
  expect(mascotReaction(important, important)).toBeUndefined()
 })
 it('keeps the gait periodic and transitions continuous', () => {
  const a=mascotPose('walk',0), b=mascotPose('walk',1.2)
  expect(a.leftFoot).toBeCloseTo(b.leftFoot)
  expect(a.rightFoot).toBeCloseTo(b.rightFoot)
  const from=mascotPose('working',0.3), to=mascotPose('waiting',0)
  expect(blendPose(from,to,0)).toEqual(from)
  expect(blendPose(from,to,1)).toEqual(to)
 })
})
