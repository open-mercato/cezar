import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, stopFixtureServer } from './agent-browser'

// #1922: real layout, including a target moving inside an unchanged outer root.
const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
let browser: AgentBrowser | undefined
let server: ChildProcess | undefined
let root: string | undefined
let baseUrl: string
let project: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cezar-composer-tips-'))
  const fixtureRoot = root
  const git = (...args: string[]) => execFileSync('git', ['-C', fixtureRoot, ...args], { timeout: 10_000 })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(root, 'README.md'), '# Composer tips fixture\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  const port = await new Promise<number>((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') { probe.close(); fail(new Error('No fixture port')); return }
      probe.close(() => done(address.port))
    })
  })
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(root, { CEZ_AGENT_MODELS_LOCKED: '1', CEZ_NO_BANNER: '1' }), stdio: 'ignore',
  })
  let healthy = false
  for (let attempt = 0; attempt < 80; attempt++) {
    try { healthy = (await fetch(`${baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(1000) })).ok } catch { /* booting */ }
    if (healthy) break
    await new Promise((done) => setTimeout(done, 250))
  }
  if (!healthy) throw new Error('Composer tips fixture never became healthy')
  project = await bootProjectId(baseUrl)
  const response = await fetch(`${baseUrl}/api/v1/workspace/ui-state`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ onboarding: { setupDismissed: true, composerTipsSeen: ['slash-skills', 'source', 'worktree', 'autonomous'] } }),
  })
  expect(response.ok).toBe(true)
  browser = AgentBrowser.open(`e2e-composer-tips-${process.pid}`)
})

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server, root)
})

const aligned = `(() => {
  const target = document.querySelector('[data-slot="variants-pill"]');
  const halo = document.querySelector('[data-slot="composer-tip-halo"]');
  const arrow = document.querySelector('.composer-tip-arrow');
  const card = document.querySelector('.onboarding-announcement');
  if (!target || !halo || !arrow || !card) return false;
  const t = target.getBoundingClientRect(), h = halo.getBoundingClientRect(), c = card.getBoundingClientRect();
  const expectedArrow = Math.min(Math.max(t.left + t.width / 2 - c.left, 18), Math.max(c.width - 18, 18));
  return Math.abs(h.left - (t.left - 4)) < 1 && Math.abs(h.top - (t.top - 4)) < 1
    && Math.abs(h.width - (t.width + 8)) < 1 && Math.abs(h.height - (t.height + 8)) < 1
    && Math.abs(parseFloat(arrow.style.left) - expectedArrow) < 1;
})()`

it('keeps the halo and arrow on their control across layout shifts and a narrow viewport', () => {
  if (!browser) throw new Error('Browser fixture did not start')
  browser.setViewport(1280, 1000)
  browser.goto(`${baseUrl}/p/${project}/new`)
  browser.snapshot()
  browser.waitForFunction(`document.querySelector('[data-tip="variants"]') !== null`)
  browser.waitForFunction(aligned)
  browser.screenshot(`${artifacts}/composer-tips-default.png`)

  const before = browser.evaluate(`(() => {
    const target = document.querySelector('[data-slot="variants-pill"]');
    const root = document.querySelector('[data-slot="composer-tip-halo"]').offsetParent;
    const r = root.getBoundingClientRect(), t = target.getBoundingClientRect();
    target.style.transform = 'translate(72px, 10px)';
    return { rootWidth: r.width, rootHeight: r.height, targetLeft: t.left };
  })()`)
  // A transform moves the target without any ResizeObserver size notification.
  browser.waitForFunction(aligned)
  const after = browser.evaluate(`(() => {
    const r = document.querySelector('[data-slot="composer-tip-halo"]').offsetParent.getBoundingClientRect();
    return { rootWidth: r.width, rootHeight: r.height, targetLeft: document.querySelector('[data-slot="variants-pill"]').getBoundingClientRect().left - 72 };
  })()`)
  expect(after).toEqual(before)
  browser.screenshot(`${artifacts}/composer-tips-moved.png`)

  browser.evaluate(`document.querySelector('[data-slot="variants-pill"]').style.transform = ''`)
  browser.evaluate(`document.querySelector('[data-slot="model-pill"]').style.minWidth = '220px'`)
  browser.waitForFunction(aligned)
  browser.screenshot(`${artifacts}/composer-tips-long-model.png`)
  browser.evaluate(`document.querySelector('[data-slot="model-pill"]').style.minWidth = ''`)
  browser.setViewport(390, 844)
  browser.waitForFunction(aligned)
  browser.screenshot(`${artifacts}/composer-tips-narrow.png`)
  expect(browser.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)

  // Halo must not intercept the control's menu or its keyboard dismissal.
  browser.snapshot()
  browser.click('[data-slot="variants-pill"]')
  browser.waitForFunction(`document.querySelector('[data-testid="variants-pill-menu"]') !== null`)
  browser.screenshot(`${artifacts}/composer-tips-control-menu.png`)
  browser.press('Escape')
  browser.waitForFunction(`document.querySelector('[data-testid="variants-pill-menu"]') === null`)
  browser.snapshot()
  browser.click('[aria-label="Close tip"]')
  browser.waitForFunction(`document.querySelector('[data-tip="variants"]') === null`)
  browser.snapshot()
  browser.click('[aria-label="Close tip"]')
  browser.waitForFunction(`document.querySelector('[data-slot="composer-tip-halo"]') === null`)
  browser.screenshot(`${artifacts}/composer-tips-dismissed.png`)
})
