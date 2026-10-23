import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DialogErrorBoundary } from '@/components/dialog-error-boundary'

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/toaster', () => ({ toast: toastMock }))

afterEach(() => {
  cleanup()
  toastMock.mockReset()
})

function Boom(): never {
  throw new TypeError("Cannot read properties of undefined (reading 'some')")
}

describe('DialogErrorBoundary', () => {
  it('contains a render error: the siblings stay, the dialog closes, a toast says why', () => {
    const onError = vi.fn()
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { getByText } = render(
      <div>
        <p>cockpit</p>
        <DialogErrorBoundary label="New project" onError={onError}>
          <Boom />
        </DialogErrorBoundary>
      </div>,
    )
    quiet.mockRestore()
    expect(getByText('cockpit')).toBeTruthy()
    expect(onError).toHaveBeenCalledOnce()
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('New project failed to open'), { tone: 'danger' })
  })

  it('renders its children when nothing throws', () => {
    const { getByText } = render(
      <DialogErrorBoundary label="New project" onError={() => {}}>
        <p>dialog</p>
      </DialogErrorBoundary>,
    )
    expect(getByText('dialog')).toBeTruthy()
  })
})
