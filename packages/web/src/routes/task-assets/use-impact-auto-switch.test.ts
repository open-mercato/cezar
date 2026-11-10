import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasAutoSwitched } from './impact-model'
import { useImpactAutoSwitch } from './use-impact-auto-switch'

const SUBJECT = { kind: 'spec', path: '.ai/specs/x.md', blobSha: 'abc' }

beforeEach(() => sessionStorage.clear())
afterEach(() => sessionStorage.clear())

function mount(run: { id: string; subject?: unknown }, hasImpact: boolean | undefined) {
  const onSwitch = vi.fn()
  const hook = renderHook(({ run, hasImpact }) => useImpactAutoSwitch(run, hasImpact, onSwitch), {
    initialProps: { run, hasImpact },
  })
  return { ...hook, onSwitch }
}

describe('useImpactAutoSwitch', () => {
  it('switches once when the report appears while the task is open, and never again', () => {
    const run = { id: 'r1', subject: SUBJECT }
    const { rerender, onSwitch, unmount } = mount(run, undefined)
    rerender({ run, hasImpact: false })
    expect(onSwitch).not.toHaveBeenCalled()
    rerender({ run, hasImpact: true })
    expect(onSwitch).toHaveBeenCalledTimes(1)
    expect(hasAutoSwitched('r1')).toBe(true)
    // A rewrite (gone and back) on the same mount does not switch again…
    rerender({ run, hasImpact: false })
    rerender({ run, hasImpact: true })
    expect(onSwitch).toHaveBeenCalledTimes(1)
    unmount()
    // …nor does a later visit that sees it appear again (the session remembers the run).
    const again = mount(run, false)
    again.rerender({ run, hasImpact: true })
    expect(again.onSwitch).not.toHaveBeenCalled()
  })

  it('does not switch when the report already existed on arrival', () => {
    const run = { id: 'r2', subject: SUBJECT }
    const { rerender, onSwitch } = mount(run, undefined)
    rerender({ run, hasImpact: true })
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('never switches a run without a subject', () => {
    const run = { id: 'r3' }
    const { rerender, onSwitch } = mount(run, false)
    rerender({ run, hasImpact: true })
    expect(onSwitch).not.toHaveBeenCalled()
  })
})
