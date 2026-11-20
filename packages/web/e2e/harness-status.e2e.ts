import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createLedger, saveLedger } from '../../cezar/src/harness/ledger'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, stopFixtureServer } from './agent-browser'

// A short, settled task is intentional: a vertical scrollbar used to reduce a 390px
// run container below @sm (384px), hiding the overlap that returned when cards closed.
const runId = 'harness-layout-fixture'
let browser: AgentBrowser
let server: ChildProcess
let root: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cezar-harness-layout-'))
  const dataDir = join(root, '.ai/cezar')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([{
    id: runId, title: 'Multi-model review fixture', task: 'Build a dashboard',
    workflow: 'harness-implement-feature', status: 'review', createdAt: new Date().toISOString(),
    tokensUsed: 42_000, archived: false, steps: [], harness: { profile: 'multi', workflow: 'harness-implement-feature' },
  }]))
  const ledger = createLedger({ workflow: 'harness-implement-feature', requestedProfile: 'multi', subject: { kind: 'brief', text: 'Build a dashboard' } })
  ledger.phases = ['implement', 'review', 'stage'].map((id) => ({ id, kind: 'agent', name: id, status: 'done', attempts: 1, artifacts: {} }))
  ledger.outcome = { status: 'contested', blockingReasons: ['Compatibility check needs verification'] }
  ledger.councils = [{ kind: 'implementation', round: 2, verdict: 'request_changes', reviewers: [
    { id: 'claude', status: 'completed', verdict: 'request_changes', findings: [] },
    { id: 'codex', status: 'completed', verdict: 'approve', findings: [] },
  ] }]
  saveLedger(dataDir, runId, ledger)
  const port = await new Promise<number>((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => done(typeof address === 'object' && address ? address.port : 0))
    })
  })
  const baseUrl = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(root, { CEZ_MULTI_MODEL: '1', CEZ_NO_BANNER: '1', CEZ_TELEMETRY: '0' }), stdio: 'ignore',
  })
  await waitForHealth(baseUrl)
  const project = await bootProjectId(baseUrl)
  expect((await fetch(`${baseUrl}/api/v1/p/${project}/runs/${runId}/harness`)).status).toBe(200)
  browser = AgentBrowser.open(`harness-layout-${process.pid}`)
  browser.setViewport(390, 1200)
  browser.goto(`${baseUrl}/p/${project}/tasks/${runId}`)
  browser.waitForFunction(`document.querySelector('[data-slot="harness-status-bar"]') !== null`)
}, 60_000)

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${url}/api/v1/health`)).ok) return } catch { /* booting */ }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error('Harness layout fixture did not boot')
}

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server, root)
})

describe('harness status layout in a real browser', () => {
  it.each([320, 375, 390, 430, 768, 1280])('keeps the status label and controls readable at %ipx', (width) => {
    browser.setViewport(width, 1200)
    browser.waitForFunction(`window.innerWidth === ${width}`)
    const geometry = browser.evaluate(`(() => {
      const bar = document.querySelector('[data-slot="harness-status-bar"]');
      const label = [...bar.children].find(el => el.textContent === 'Verification needed');
      const count = [...bar.children].find(el => el.textContent.includes('/3 done'));
      const timeline = bar.querySelector('button');
      const bounds = bar.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(label);
      const labelBox = label.getBoundingClientRect();
      const others = [count, timeline].map(el => el.getBoundingClientRect());
      const rects = [...range.getClientRects()];
      return {
        text: label.textContent,
        labelFits: rects.every(r => r.left >= labelBox.left - 1 && r.right <= labelBox.right + 1),
        noOverlap: rects.every(r => others.every(o => r.right <= o.left || r.left >= o.right || r.bottom <= o.top || r.top >= o.bottom)),
        controlsFit: others.every(r => r.left >= bounds.left - 1 && r.right <= bounds.right + 1),
        overflow: bar.scrollWidth > bar.clientWidth,
      };
    })()`)
    expect(geometry).toEqual({ text: 'Verification needed', labelFits: true, noOverlap: true, controlsFit: true, overflow: false })
    if (width === 390) browser.screenshot(resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e/harness-status-390.png'), { viewport: true })
  })
})
