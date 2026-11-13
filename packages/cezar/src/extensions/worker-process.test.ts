import { describe, expect, it } from 'vitest'
import { RestartBudget, spawnWorkerProcess, workerEnv, type WorkerProcess } from './worker-process.ts'

function start(code: string) {
  const frames: unknown[] = [], logs: string[] = [], exits: Error[] = []
  const worker: WorkerProcess = spawnWorkerProcess({
    label: '[test]', args: ['-e', code], cwd: process.cwd(), log: line => { logs.push(line) },
    onFrame: frame => { frames.push(frame) }, onExit: error => { exits.push(error) },
  })
  return { worker, frames, logs, exits }
}

describe('worker process supervisor', () => {
  it('forwards network settings only, never PATH, HOME, secrets or NODE_OPTIONS', () => {
    expect(workerEnv({ PATH: '/bin', HOME: '/h', NODE_OPTIONS: '--require x', TOKEN: 's', HTTPS_PROXY: 'http://p', SSL_CERT_FILE: '/ca' }))
      .toEqual({ NODE_ENV: 'production', HTTPS_PROXY: 'http://p', SSL_CERT_FILE: '/ca' })
  })

  it('parses newline-delimited frames split across chunks', async () => {
    const { frames, exits } = start(`process.stdout.write('{"a":'); setTimeout(() => process.stdout.write('1}\\n{"b":2}\\n'), 50)`)
    await expect.poll(() => exits.length).toBe(1)
    expect(frames).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('kills a worker that streams a frame over 1 MiB before its newline', async () => {
    const { worker, logs, exits } = start(`process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000)`)
    await expect.poll(() => exits.length, { timeout: 5_000 }).toBe(1)
    expect(worker.child.signalCode).toBe('SIGKILL')
    expect(logs.some(line => /protocol error: frame exceeds 1 MiB/.test(line))).toBe(true)
  })

  it('kills a worker on a frame that is not JSON', async () => {
    const { worker, exits } = start(`process.stdout.write('nope\\n'); setInterval(() => {}, 1000)`)
    await expect.poll(() => exits.length).toBe(1)
    expect(worker.child.signalCode).toBe('SIGKILL')
  })

  it('kills a worker whose frame handler throws', async () => {
    const exits: Error[] = []
    const worker = spawnWorkerProcess({ label: '[test]', args: ['-e', `process.stdout.write('{}\\n'); setInterval(() => {}, 1000)`], cwd: process.cwd(), log: () => {}, onFrame: () => { throw new Error('bad') }, onExit: error => { exits.push(error) } })
    await expect.poll(() => exits.length).toBe(1)
    expect(worker.child.signalCode).toBe('SIGKILL')
  })

  it('kills a hung worker on the third consecutive timeout, and an answer resets the count', async () => {
    const { worker, exits } = start(`setInterval(() => {}, 1000)`)
    worker.timedOut(); worker.timedOut(); worker.answered(); worker.timedOut(); worker.timedOut()
    expect(worker.alive).toBe(true)
    worker.timedOut()
    await expect.poll(() => exits.length).toBe(1)
    expect(worker.child.signalCode).toBe('SIGKILL')
  })

  it('drains stderr and keeps a tail', async () => {
    const { worker, exits } = start(`for (let i = 0; i < 2000; i++) process.stderr.write('line ' + i + '\\n'); process.stderr.write('last')`)
    await expect.poll(() => exits.length).toBe(1)
    expect(worker.stderrTail().endsWith('last')).toBe(true)
  })

  it('stop escalates SIGTERM to SIGKILL, bounded', async () => {
    const { worker, frames, exits } = start(`process.on('SIGTERM', () => {}); process.stdout.write('{"ready":true}\\n'); setInterval(() => {}, 1000)`)
    // Stop only once the child ignores SIGTERM, or it would die of the first signal.
    await expect.poll(() => frames.length).toBe(1)
    const started = Date.now()
    await worker.stop(50)
    expect(exits).toHaveLength(1)
    expect(worker.child.signalCode).toBe('SIGKILL')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('reports exit exactly once', async () => {
    const { worker, exits } = start(`setInterval(() => {}, 1000)`)
    worker.kill(); worker.kill()
    await worker.exited
    await worker.stop(0)
    expect(exits).toHaveLength(1)
  })
})

describe('restart budget', () => {
  it('backs off exponentially, gives up after the limit, and forgives a worker that lived a minute', () => {
    const budget = new RestartBudget({ maxRestarts: 2 })
    expect(budget.crashed(0, 10)).toEqual({ attempt: 1, delayMs: 1_000 })
    expect(budget.crashed(0, 20)).toEqual({ attempt: 2, delayMs: 2_000 })
    expect(budget.crashed(0, 30)).toBeUndefined()
    expect(budget.crashed(0, 120_000)).toEqual({ attempt: 1, delayMs: 1_000 })
  })
})

it('reports worker death while a descendant still owns its output pipes', async () => {
  let descendant = 0
  let exitCalls = 0
  const worker = spawnWorkerProcess({
    label: '[inherited pipes]', cwd: process.cwd(),
    args: ['-e', `const {spawn} = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:['ignore',process.stdout,process.stderr]});
      process.stdout.write(JSON.stringify({pid:child.pid})+'\\n', () => process.exit(7));`],
    sanitizeStderr: text => text, log: () => {},
    onFrame: frame => { descendant = (frame as {pid:number}).pid },
    onExit: () => { exitCalls++ },
  })
  try {
    await new Promise<void>(resolve => worker.child.once('exit', () => resolve()))
    expect(worker.alive).toBe(false)
    expect(exitCalls).toBe(1)
    await worker.exited
    await worker.stop(0)
    expect(exitCalls).toBe(1)
  } finally {
    if (descendant) process.kill(descendant, 'SIGKILL')
    await worker.stop(0)
  }
})
