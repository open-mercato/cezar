import { assertType, describe, it } from 'vitest'
import type { Runner } from '@open-mercato/cezar-contract'
import type { UiBackend } from './ui-events.ts'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/**
 * `UiBackend` is the browser-side mirror of the runner union and deliberately restates it (the
 * protocol module stays dependency-free). This pins the mirror to the contract's `Runner`, so a
 * runner added in `packages/contract/src/health.ts` that is not mirrored here is a type error —
 * the same drift guard `packages/cezar/src/core/ui-events.test.ts` applies to the server mirror.
 */
describe('UiBackend mirrors the contract runner union', () => {
  it('is structurally identical to Runner', () => {
    assertType<Equal<UiBackend, Runner>>(true)
  })
})
