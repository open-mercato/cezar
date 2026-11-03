import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeClipboard } from './clipboard'

/** Telemetry `24be63a4`: a remote cockpit on plain http has no `navigator.clipboard`. */

function stubExecCommand(result: boolean | (() => boolean)) {
  const execCommand = vi.fn((command: string) => {
    void command
    return typeof result === 'function' ? result() : result
  })
  Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true })
  return execCommand
}

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'execCommand')
})

describe('writeClipboard', () => {
  it('uses the async clipboard when the context has one', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const execCommand = stubExecCommand(true)

    await writeClipboard('hello')

    expect(writeText).toHaveBeenCalledWith('hello')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('falls back to a hidden textarea when navigator.clipboard is undefined', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    let copied = ''
    const execCommand = stubExecCommand(() => {
      copied = document.querySelector('textarea')?.value ?? ''
      return true
    })

    await expect(writeClipboard('/srv/repo')).resolves.toBeUndefined()

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(copied).toBe('/srv/repo')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('falls back when the async clipboard rejects', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    const execCommand = stubExecCommand(true)

    await writeClipboard('x')

    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('rejects — never throws synchronously — when neither path can copy', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    stubExecCommand(false)

    let pending: Promise<void> | undefined
    expect(() => { pending = writeClipboard('x') }).not.toThrow()
    await expect(pending).rejects.toThrow('Clipboard unavailable')
  })

  it('rejects when execCommand is missing entirely', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    Reflect.deleteProperty(document, 'execCommand')

    await expect(writeClipboard('x')).rejects.toThrow()
  })
})
