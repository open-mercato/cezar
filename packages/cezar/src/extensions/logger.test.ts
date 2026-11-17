import { SecretStore } from '../workspace/secrets.ts'
import { expect, it } from 'vitest'
import { extensionLogger } from './logger.ts'
import { ExtensionHostContext } from './context.ts'

it('prefixes extension log lines and caps a flood at 100 per minute', () => {
  const lines: string[] = []
  let clock = 0
  const log = extensionLogger('proj', (level, line) => lines.push(`${level} ${line}`), () => clock)
  log('info', 'hello', 'acme.ext')
  expect(lines).toEqual(['info [extension acme.ext] (proj) hello'])
  for (let i = 0; i < 150; i++) log('info', 'spam', 'acme.ext')
  expect(lines.length).toBe(101)
  expect(lines.at(-1)).toMatch(/rate limit/)
  clock = 60_000
  log('error', 'after', 'acme.ext')
  expect(lines.at(-1)).toBe('error [extension acme.ext] (proj) after')
})

it('rejects a suppressed logger RPC so callers cannot checkpoint an unpublished diagnostic', async () => {
  const lines: string[] = []
  let clock = 0
  const log = extensionLogger('p', (_level, line) => { lines.push(line) }, () => clock)
  const context = new ExtensionHostContext({ secrets: new SecretStore(), dataDir: '/unused', projectRoot: '/unused', projectId: 'p', extensionId: 'chat', permissions: [], log })
  const signal = new AbortController().signal
  for (let i = 0; i < 100; i++) await context.dispatch('logger.info', { message: 'ordinary' }, signal)
  await expect(context.dispatch('logger.error', { message: 'record-101 not processed' }, signal)).rejects.toThrow()
  expect(lines.some(line => line.includes('record-101'))).toBe(false)
  clock = 60_000
  await expect(context.dispatch('logger.error', { message: 'record-101 not processed' }, signal)).resolves.toBeNull()
  expect(lines.filter(line => line.includes('record-101'))).toHaveLength(1)
})
