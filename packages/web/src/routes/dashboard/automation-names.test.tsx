import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useAutomationNames } from './automation-names'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

it('converges with more definitions than the bounded history can hold (#1959)', () => {
  const observed = Array.from({ length: 501 }, (_, i) => ({
    projectId: 'alpha', automationId: String(i), name: `Automation ${i}`, revision: 1,
  }))
  let renders = 0
  const { result, rerender } = renderHook(() => {
    // Fail a non-converging effect deterministically without hanging the test worker.
    if (++renders > 5) throw new Error('Automation name history does not converge')
    return useAutomationNames([...observed])
  })
  rerender()
  expect(result.current('alpha', '500')).toBe('Automation 500')
  expect(JSON.parse(localStorage.getItem('cezar.dashboard.automation-names.v1') ?? '[]')).toHaveLength(500)
  expect(renders).toBeLessThanOrEqual(3)
})
