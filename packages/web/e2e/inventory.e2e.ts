import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
import type { ExtensionInventoryItem, ExtensionUninstallImpact } from '@open-mercato/cezar-api-client'

const item: ExtensionInventoryItem = {
  record: { manifest: { id: 'example', name: 'Mattermost', version: '1.0.0', apiVersion: '0.1', entry: 'index.js', capabilities: [], permissions: [],
    contributes: { forms: [], panels: [], commands: [], chatProviders: [{ id: 'chat', label: 'Mattermost', receiveModel: 'ordered', commandPrefix: '!', groupPrefix: 'group:', credentials: [], limits: { maxText: 4000, buttonsPerMessage: 5, perChatPerSecond: 1, perBotPerSecond: 10 }, discoveryUrl: 'https://example.com' }] } },
    source: '/untrusted/bundled-chat/example', installedAt: '', enabled: false, status: 'disabled' },
  management: { enable: false, disable: false, update: false, uninstall: false },
  provenance: { kind: 'folder', source: '/untrusted/bundled-chat/example' }, availability: 'missing', selectedVersion: '1.0.0', providers: [{ id: 'example/chat', label: 'Mattermost' }],
}
const impact = (changed: boolean): ExtensionUninstallImpact => ({
  extensionId: 'example', scope: 'all-projects', revision: (changed ? 'b' : 'a').repeat(64), retainsConnectionData: true,
  projects: [{ projectId: changed ? 'gamma' : 'beta', name: changed ? 'Gamma app' : 'Beta app', enabled: true, providers: ['example/chat'] }],
})

test('cold missing recovery retains focus, project navigation and mobile wrapping', async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 320, height: 812 })
  const requests: string[] = []
  await browser.route(/\/api\/v1\//, async route => {
    const path = new URL(route.request.url).pathname
    requests.push(path)
    if (path.endsWith('/inventory')) return route.fulfill({ json: { extensions: [item] } })
    if (path.endsWith('/access')) return route.fulfill({ json: { extensions: [] } })
    if (/\/(telegram|slack|discord)$/.test(path)) return route.fulfill({ json: { available: false, notifications: { available: false, reason: 'webhooks_off' }, taskControl: { available: false }, receivers: [], bots: [], grants: [] } })
    if (path.endsWith('/tracker/association')) return route.fulfill({ json: { association: null } })
    if (path.endsWith('/tracker/connection')) return route.fulfill({ json: { connection: null } })
    if (path.endsWith('/e2e')) return route.fulfill({ json: { configFile: null, workflow: false, credentials: [], setup: null } })
    return route.fulfill({ status: 404, json: { error: 'Fixture: unavailable' } })
  })
  await app.open('/e2e/inventory-harness.html?recovery=1')
  await expect(screen.getByRole('region', 'Mattermost')).toBeVisible()
  await expect(screen.getByText('Missing', { exact: true })).toBeVisible()
  expect(await browser.evaluate(() => document.activeElement?.textContent ?? null)).toBe('Mattermost')
  await expect(screen.getByRole('button', 'Connect Mattermost')).not.toBeVisible()
  await screen.getByRole('link', 'Manage extension').click()
  await expect(screen.getByRole('listitem', 'Mattermost')).toBeVisible()
  await expect(screen.getByText('Local extension', { exact: true })).toBeVisible()
  await expect(screen.getByRole('button', 'Enable', { exact: true })).not.toBeVisible()
  expect(await browser.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  expect(requests.some(path => path.includes('/extensions/example/chat/'))).toBe(false)
  await expect(screen.getByRole('combobox', 'Project access')).toHaveAttribute('data-value', 'default')
  expect(requests.some(path => path.includes('/p/alpha/extensions/inventory'))).toBe(true)
})

test('global uninstall refreshes stale preview and needs a second explicit confirmation', async ({ app, browser, screen }) => {
  let changed = false
  let removed = false
  const deletes: URL[] = []
  await browser.route(/\/api\/v1\//, async route => {
    const url = new URL(route.request.url)
    if (route.request.method === 'DELETE') {
      deletes.push(url)
      if (!changed) { changed = true; return route.fulfill({ status: 409, json: { error: 'Impact changed' } }) }
      removed = true
      return route.fulfill({ json: { ok: true } })
    }
    if (url.pathname.endsWith('/uninstall-impact')) return route.fulfill({ json: impact(changed) })
    if (url.pathname.endsWith('/inventory')) return route.fulfill({ json: { extensions: removed ? [] : [{ ...item, availability: 'disabled', management: { enable: true, disable: false, update: true, uninstall: true } }] } })
    if (url.pathname.endsWith('/access')) return route.fulfill({ json: { extensions: removed ? [] : [item.record] } })
    return route.fulfill({ status: 404, json: { error: 'Fixture: unavailable' } })
  })
  await app.open('/e2e/inventory-harness.html')
  await screen.getByRole('button', 'Uninstall', { exact: true }).click()
  await expect(screen.getByText(/Beta app.*Enabled/)).toBeVisible()
  await expect(screen.getByText(/removes the extension from all projects/)).toBeVisible()
  await screen.getByRole('button', 'Uninstall and keep data').click()
  await expect(screen.getByText(/Gamma app.*Enabled/)).toBeVisible()
  await expect(screen.getByText(/confirm again/)).toBeVisible()
  expect(deletes.length).toBe(1)
  expect(deletes[0]!.searchParams.get('impactRevision')).toBe('a'.repeat(64))
  await screen.getByRole('button', 'Uninstall and keep data').click()
  await expect(screen.getByText('No extensions installed', { exact: true })).toBeVisible()
  expect(deletes.length).toBe(2)
  expect(deletes[1]!.searchParams.get('impactRevision')).toBe('b'.repeat(64))
  expect(deletes[1]!.searchParams.get('removeData')).toBe('false')
})

for (const viewport of [{ width: 320, height: 812 }, { width: 375, height: 812 }, { width: 640, height: 450 }]) {
  test(`large uninstall remains reachable at ${viewport.width}x${viewport.height}`, async ({ app, browser, screen }) => {
    // 640x450 is the CSS viewport of a 1280x900 desktop at 200% browser zoom.
    await browser.setViewport(viewport)
    const deletes: URL[] = []
    const projects = Array.from({ length: 20 }, (_, i) => ({ projectId: `project-${i}`, name: `Project ${i} ` + 'LongUnbrokenProjectName'.repeat(5), enabled: true, providers: ['example/chat'] }))
    await browser.route(/\/api\/v1\//, async route => {
      const url = new URL(route.request.url)
      if (route.request.method === 'DELETE') { deletes.push(url); return route.fulfill({ json: { ok: true } }) }
      if (url.pathname.endsWith('/uninstall-impact')) return route.fulfill({ json: { ...impact(false), projects } })
      if (url.pathname.endsWith('/inventory')) return route.fulfill({ json: { extensions: [{ ...item, availability: 'disabled', management: { enable: true, disable: false, update: true, uninstall: true } }] } })
      if (url.pathname.endsWith('/access')) return route.fulfill({ json: { extensions: [item.record] } })
      return route.fulfill({ status: 404, json: { error: 'Fixture: unavailable' } })
    })
    await app.open('/e2e/inventory-harness.html')
    const open = async () => {
      await screen.getByRole('button', 'Uninstall', { exact: true }).click()
      await expect(screen.getByText(/Project 19/)).toBeAttached()
      await expect(screen.getByRole('button', 'Cancel', { exact: true })).toBeFocused()
      const box = await screen.getByRole('alertdialog').boundingBox()
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
      expect(await browser.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
    }
    await open()
    const title = await screen.getByRole('heading', 'Uninstall Mattermost?').boundingBox()
    expect(title!.y).toBeGreaterThanOrEqual(0)
    expect(title!.y + title!.height).toBeLessThanOrEqual(viewport.height)
    await app.screenshot(`uninstall-${viewport.width}-top`)
    const review = screen.getByRole('region', 'Uninstall impact')
    await review.focus()
    await review.press('Control+End')
    await screen.getByText(/Project 19/).scrollIntoView()
    const last = await screen.getByText(/Project 19/).boundingBox()
    expect(last!.y).toBeGreaterThanOrEqual(0)
    expect(last!.y + last!.height).toBeLessThanOrEqual(viewport.height)
    await app.screenshot(`uninstall-${viewport.width}-bottom`)
    await screen.getByRole('button', 'Cancel', { exact: true }).click()
    expect(deletes.length).toBe(0)
    await open()
    await screen.getByRole('button', 'Cancel', { exact: true }).press('Enter')
    expect(deletes.length).toBe(0)
    await open()
    await screen.getByRole('button', 'Cancel', { exact: true }).press('Tab')
    await expect(screen.getByRole('button', 'Uninstall and keep data')).toBeFocused()
    await screen.getByRole('button', 'Uninstall and keep data').press('Enter')
    await expect(screen.getByRole('alertdialog')).not.toBeVisible()
    expect(deletes.length).toBe(1)
    await open()
    await screen.getByRole('button', 'Uninstall and keep data').click()
    await expect(screen.getByRole('alertdialog')).not.toBeVisible()
    expect(deletes.length).toBe(2)
    expect(deletes.every(url => url.searchParams.get('removeData') === 'false')).toBe(true)
  })
}

for (const availability of ['missing', 'flag-disabled', 'hosted'] as const) {
  test(`late running access cannot revive ${availability} inventory`, async ({ app, browser, screen }) => {
    let release!: () => void
    const accessReady = new Promise<void>(resolve => { release = resolve })
    const workerRequests: string[] = []
    await browser.route(/\/api\/v1\//, async route => {
      const path = new URL(route.request.url).pathname
      if (path.includes('/extensions/example/chat/')) workerRequests.push(path)
      if (path.endsWith('/inventory')) return route.fulfill({ json: { extensions: [{ ...item, availability }] } })
      if (path.endsWith('/access')) {
        await accessReady
        return route.fulfill({ json: { extensions: [{ ...item.record, enabled: true, status: 'running' }] } })
      }
      return route.fulfill({ status: 404, json: { error: 'Fixture: unavailable' } })
    })
    try {
      await app.open('/e2e/inventory-harness.html?recovery=1')
      await expect(screen.getByRole('link', 'Manage extension')).toBeVisible()
      release()
      // Negated assertion waits continuously, allowing the independent access reply to settle.
      await expect(screen.getByRole('button', 'Connect Mattermost')).not.toBeVisible()
      await expect(screen.getByRole('link', 'Manage extension')).toBeVisible()
      expect(workerRequests).toHaveLength(0)
      await screen.getByRole('link', 'Manage extension').click()
      await expect(screen.getByRole('listitem', 'Mattermost')).toBeVisible()
    } finally { release() }
  })
}

for (const width of [320, 375]) {
  test(`shipped flag-off permissions and canonical native link at ${width}px`, async ({ app, browser, screen }) => {
    await browser.setViewport({ width, height: 812 })
    let enabled = false
    const mutations: string[] = []
    const shipped = () => ({ ...item, record: { ...item.record, source: 'bundled', enabled }, provenance: { kind: 'bundled', hostVersion: '1', integrity: 'digest' }, availability: enabled ? 'available' : 'disabled', management: { enable: !enabled, disable: enabled, update: false, uninstall: false }, providers: [{ id: 'telegram', label: 'Telegram' }], installedCandidate: { ...item, availability: 'flag-disabled' } })
    await browser.route(/\/api\/v1\//, async route => {
      const path = new URL(route.request.url).pathname
      if (route.request.method === 'POST') {
        mutations.push(path)
        if (path.endsWith('/enable')) enabled = true
        if (path.endsWith('/disable')) enabled = false
        return route.fulfill({ json: shipped().record })
      }
      if (path.endsWith('/inventory')) return route.fulfill({ json: { extensions: [shipped(), { ...item, record: { ...item.record, manifest: { ...item.record.manifest, id: 'installed', name: 'Installed only' } }, availability: 'flag-disabled' }] } })
      if (path.endsWith('/access')) return route.fulfill({ json: { extensions: [] } })
      if (/\/(telegram|slack|discord)$/.test(path)) return route.fulfill({ json: { available: false, notifications: { available: false, reason: 'webhooks_off' }, taskControl: { available: false }, receivers: [], bots: [], grants: [] } })
      return route.fulfill({ status: 404, json: { error: 'Fixture: unavailable' } })
    })
    await app.open('/e2e/inventory-harness.html?off=1')
    await expect(screen.getByRole('listitem', 'Mattermost').getByText('Selected implementation', { exact: true })).toBeVisible()
    const candidate = screen.getByRole('region', 'Inactive installed candidate')
    await expect(candidate).toBeVisible()
    await expect(candidate.getByRole('button')).toHaveCount(0)
    await expect(screen.getByRole('listitem', 'Installed only').getByRole('button')).toHaveCount(0)
    await screen.getByRole('button', 'Enable', { exact: true }).focus()
    await browser.keyboard.press('Enter')
    await screen.getByRole('button', 'Approve and enable').press('Enter')
    await expect(screen.getByRole('button', 'Disable', { exact: true })).toBeVisible()
    await screen.getByRole('button', 'Disable', { exact: true }).press('Enter')
    await expect(screen.getByRole('button', 'Enable', { exact: true })).toBeVisible()
    expect(mutations.filter(path => path.endsWith('/enable')).length).toBe(1)
    expect(mutations.filter(path => path.endsWith('/disable')).length).toBe(1)
    await expect(screen.getByRole('button', 'Uninstall', { exact: true })).not.toBeVisible()
    expect(await browser.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await screen.getByRole('link', /Telegram/).click()
    await expect(screen.getByRole('region', 'Telegram')).toBeVisible()
    // Inventory-owned canonical IDs link back to their extension row.
    await expect(screen.getByRole('link', 'Manage extension')).toBeVisible()
    expect(await browser.evaluate(() => [...document.querySelectorAll('a')].find(a => a.textContent === 'Manage extension')?.getAttribute('href') ?? null)).toMatch(/^\/settings\/global\/extensions\?project=[^&]+&extension=example$/)
    await expect(screen.getByText(/Connection setup requires a running extension/)).not.toBeVisible()
  })
}

test('candidate uninstall preserves selection and requires new confirmation after 409', async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 375, height: 812 })
  let changed = false, removed = false
  const deletes: URL[] = []
  const selected = () => ({ ...item, record: { ...item.record, source: 'bundled' }, provenance: { kind: 'bundled', hostVersion: '1', integrity: 'digest' }, availability: 'available', providers: [{ id: 'telegram', label: 'Telegram' }], ...(!removed ? { installedCandidate: { ...item, availability: 'disabled', selectedVersion: '2.0.0', record: { ...item.record, manifest: { ...item.record.manifest, version: '2.0.0' } }, management: { enable: false, disable: false, update: true, uninstall: true } } } : {}) })
  await browser.route(/\/api\/v1\//, async route => {
    const url = new URL(route.request.url)
    if (route.request.method === 'DELETE') {
      deletes.push(url)
      if (!changed) { changed = true; return route.fulfill({ status: 409, json: { error: 'Impact changed' } }) }
      removed = true
      return route.fulfill({ json: { ok: true } })
    }
    if (url.pathname.endsWith('/uninstall-impact')) return route.fulfill({ json: impact(changed) })
    if (url.pathname.endsWith('/inventory')) return route.fulfill({ json: { extensions: [selected()] } })
    if (url.pathname.endsWith('/access')) return route.fulfill({ json: { extensions: [] } })
    return route.fulfill({ status: 404, json: { error: 'Fixture: unavailable' } })
  })
  await app.open('/e2e/inventory-harness.html')
  const candidate = screen.getByRole('region', 'Inactive installed candidate')
  await expect(candidate.getByText('2.0.0', { exact: true })).toBeVisible()
  await expect(candidate.getByRole('button', 'Enable', { exact: true })).not.toBeVisible()
  await candidate.getByRole('button', 'Uninstall', { exact: true }).click()
  await expect(screen.getByText(/shipped implementation remains selected/)).toBeVisible()
  await screen.getByRole('checkbox').check()
  await screen.getByRole('button', 'Uninstall and delete data').click()
  await expect(screen.getByText(/Gamma app.*Enabled/)).toBeVisible()
  await expect(screen.getByText(/confirm again/)).toBeVisible()
  await expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(deletes.length).toBe(1)
  await screen.getByRole('button', 'Uninstall and keep data').press('Enter')
  await expect(candidate).not.toBeVisible()
  // The shipped selection survives; its label shows only while a candidate competes.
  const kept = screen.getByRole('listitem', 'Mattermost')
  await expect(kept.getByText('Shipped with Cezar', { exact: true })).toBeVisible()
  await expect(kept.getByRole('link', 'Manage Telegram connection')).toBeVisible()
  await expect(kept.getByText('Selected implementation', { exact: true })).not.toBeVisible()
  expect(deletes[1]!.searchParams.get('impactRevision')).toBe('b'.repeat(64))
  expect(deletes[1]!.searchParams.get('removeData')).toBe('false')
})

test('fresh inventory revokes an open approval', async ({ app, browser, screen }) => {
  let permitted = true
  const posts: string[] = []
  await browser.route(/\/api\/v1\//, async route => {
    const path = new URL(route.request.url).pathname
    if (route.request.method === 'POST') posts.push(path)
    if (path.endsWith('/inventory')) return route.fulfill({ json: { extensions: [{ ...item, availability: 'disabled', management: { ...item.management, enable: permitted } }] } })
    if (path.endsWith('/access')) return route.fulfill({ json: { extensions: [] } })
    return route.fulfill({ status: 404, json: { error: 'Fixture: unavailable' } })
  })
  await app.open('/e2e/inventory-harness.html')
  await screen.getByRole('button', 'Enable', { exact: true }).click()
  await expect(screen.getByRole('button', 'Approve and enable')).toBeEnabled()
  permitted = false
  // Fixture invalidation while the modal is open models a live inventory change.
  await browser.evaluate(() => { (Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Refresh fixture inventory'))!.click(); return true })
  await expect(screen.getByRole('button', 'Approve and enable')).toBeDisabled()
  expect(posts).toHaveLength(0)
})

test('stopping an external provider discards unsent setup credentials', async ({ app, browser, screen }) => {
  let running = true
  const declaration = { ...item.record.manifest.contributes!.chatProviders![0]!, credentials: [{ name: 'token', label: 'Fixture access token', secret: true }] }
  const record = () => ({ ...item.record, enabled: true, status: running ? 'running' : 'failed', manifest: { ...item.record.manifest, contributes: { ...item.record.manifest.contributes, chatProviders: [declaration] } } })
  await browser.route(/\/api\/v1\//, async route => {
    const path = new URL(route.request.url).pathname
    if (path.endsWith('/inventory')) return route.fulfill({ json: { extensions: [{ ...item, record: record(), availability: running ? 'available' : 'failed' }] } })
    if (path.endsWith('/access')) return route.fulfill({ json: { extensions: [record()] } })
    if (path.endsWith('/extensions/example/chat/chat')) return route.fulfill({ json: { available: true, notifications: { available: true }, taskControl: { available: true }, receivers: [], bots: [], grants: [] } })
    if (path.endsWith('/webhooks')) return route.fulfill({ json: { receivers: [], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } } })
    return route.fulfill({ status: 404, json: { error: 'Fixture: unavailable' } })
  })
  await app.open('/e2e/inventory-harness.html?recovery=1&webhooks=1')
  const open = async () => {
    await screen.getByRole('button', 'Connect Mattermost', { exact: true }).click()
    await screen.getByRole('button', /^Notifications only/).click()
    return screen.getByLabel('Fixture access token')
  }
  await (await open()).fill('unsent-fixture-secret')
  await screen.getByRole('checkbox', 'This bot is dedicated to this project').check()
  await expect(screen.getByRole('button', 'Continue', { exact: true })).toBeEnabled()
  running = false
  const refresh = () => browser.evaluate(() => { (Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Refresh fixture inventory'))!.click(); return true })
  await refresh()
  await expect(screen.getByRole('link', 'Manage extension')).toBeVisible()
  await expect(screen.getByLabel('Fixture access token')).not.toBeVisible()
  running = true
  await refresh()
  await open()
  await screen.getByRole('checkbox', 'This bot is dedicated to this project').check()
  // Secure fields cannot be read by the browser driver; the empty credential must block Continue.
  await expect(screen.getByRole('button', 'Continue', { exact: true })).toBeDisabled()
})

for (const width of [320, 375]) {
  test(`selection review preserves disabled access and keyboard focus at ${width}px`, async ({ app, browser, screen }) => {
    await browser.setViewport({ width, height: 812 })
    const candidate = { ...item.record, integrity: 'sha512-Yg==', source: '/candidate/' + 'long-path'.repeat(30), manifest: { ...item.record.manifest, version: '2.0.0' } }
    const selected = { ...item, record: { ...item.record, integrity: 'sha512-YQ==' }, availability: 'disabled' as const,
      provenance: { kind: 'bundled' as const, hostVersion: '1', integrity: 'sha512-YQ==' }, providers: [{ id: 'telegram', label: 'Telegram' }],
      installedCandidate: { ...item, record: candidate, availability: 'disabled' as const, selectedVersion: '2.0.0' } }
    const commits: unknown[] = []
    let previews = 0
    await browser.route(/\/api\/v1\//, async route => {
      const path = new URL(route.request.url).pathname
      if (path.endsWith('/inventory')) return route.fulfill({ json: { extensions: [selected] } })
      if (path.endsWith('/access')) return route.fulfill({ json: { extensions: [] } })
      if (path.endsWith('/preview')) {
        previews++
        return route.fulfill({ json: { ...JSON.parse(route.request.postData ?? '{}'), provider: 'telegram', revision: 'a'.repeat(64), selectionRevision: null, current: selected.record, candidate, addedPermissions: [], addedCapabilities: [] } })
      }
      if (path.endsWith('/select')) {
        commits.push(JSON.parse(route.request.postData ?? '{}'))
        return route.fulfill({ status: 400, json: { error: 'Activation failed; previous implementation restored. Review again.' } })
      }
      return route.fulfill({ status: 404, json: { error: 'Fixture unavailable' } })
    })
    await app.open('/e2e/inventory-harness.html')
    await expect(screen.getByRole('button', 'Use installed version')).toBeVisible()
    expect(previews).toBe(0)
    await screen.getByRole('button', 'Use installed version').focus()
    await browser.keyboard.press('Enter')
    await expect(screen.getByText('Added permissions: None')).toBeVisible()
    await expect(screen.getByText('Project access after selection: Disabled (preserved)')).toBeVisible()
    const region = screen.getByRole('region', 'Implementation selection review')
    await expect(region).toBeFocused()
    await browser.keyboard.press('End')
    await expect.poll(() => browser.evaluate(() => {
      const region = document.querySelector('[aria-label="Implementation selection review"]')!
      return region.scrollTop > 0 && region.scrollHeight > region.clientHeight
    })).toBe(true)
    await app.screenshot(`selection-${width}-scrolled`)
    await browser.keyboard.press('Tab')
    await expect(screen.getByRole('button', 'Cancel selection')).toBeFocused()
    await browser.keyboard.press('Enter')
    await expect(screen.getByRole('button', 'Use installed version')).toBeFocused()
    expect(commits.length).toBe(0)
    await browser.keyboard.press('Enter')
    await expect(screen.getByText('Added permissions: None')).toBeVisible()
    expect(await browser.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await screen.getByRole('button', 'Confirm selection').focus()
    await browser.keyboard.press('Enter')
    await expect(screen.getByRole('alert')).toContainText('previous implementation restored')
    await expect(screen.getByRole('button', 'Confirm selection')).toBeDisabled()
    expect(commits).toEqual([{ target: { kind: 'installed', extensionId: 'example', localProviderId: 'chat', integrity: 'sha512-Yg==' }, enabled: false, revision: 'a'.repeat(64) }])
    await screen.getByRole('button', 'Review again').click()
    await expect(screen.getByText('Added permissions: None')).toBeVisible()
    expect(commits.length).toBe(1)
  })
}

test('pending commit survives changed inventory without second submission', async ({app,browser,screen}) => {
 const candidate={...item.record,integrity:'sha512-Yg=='}
 let selected={...item,record:{...item.record,integrity:'sha512-YQ=='},provenance:{kind:'bundled',hostVersion:'1',integrity:'sha512-YQ=='},providers:[{id:'telegram',label:'Telegram'}],installedCandidate:{...item,record:candidate}}
 let commits=0
 let release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 await browser.route(/\/api\/v1\//,async route=>{
  const path=new URL(route.request.url).pathname
  if(path.endsWith('/inventory'))return route.fulfill({json:{extensions:[selected]}})
  if(path.endsWith('/access'))return route.fulfill({json:{extensions:[]}})
  if(path.endsWith('/preview'))return route.fulfill({json:{...JSON.parse(route.request.postData??'{}'),provider:'telegram',revision:'a'.repeat(64),selectionRevision:null,current:selected.record,candidate,addedPermissions:[],addedCapabilities:[]}})
  if(path.endsWith('/select')){commits++;await gate;return route.fulfill({status:400,json:{error:'Failed activation'}})}
  return route.fulfill({status:404,json:{error:'fixture'}})
 })
 try {
  await app.open('/e2e/inventory-harness.html')
  await screen.getByRole('button','Use installed version').click()
  await expect(screen.getByText('Added permissions: None')).toBeVisible()
  await screen.getByRole('button','Confirm selection').click()
  await expect.poll(()=>commits).toBe(1)
  selected={...selected,record:{...selected.record,status:'failed'}}
  await browser.evaluate(()=>{(Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Refresh fixture inventory') as HTMLButtonElement).click(); return null })
  await expect(screen.getByRole('dialog')).not.toBeVisible()
  const action = screen.getByRole('button','Use installed version')
  if (await action.isEnabled()) {
   await action.click()
   await expect(screen.getByText('Added permissions: None')).toBeVisible()
   await screen.getByRole('button','Confirm selection').click()
   await expect.poll(()=>commits).toBe(2)
  }
  expect(commits,'Only one unresolved selection commit is allowed').toBe(1)
  release()
  await expect(screen.getByRole('alert')).toContainText('Failed activation')
  await expect(action).toBeEnabled()
 } finally {release()}
})

test('pending commit survives project switch and retains failure only for its origin', async ({app,browser,screen}) => {
 const candidate={...item.record,integrity:'sha512-Yg=='}
 let selected={...item,record:{...item.record,integrity:'sha512-YQ=='},provenance:{kind:'bundled',hostVersion:'1',integrity:'sha512-YQ=='},providers:[{id:'telegram',label:'Telegram'}],installedCandidate:{...item,record:candidate}}
 let commits=0
 let release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 await browser.route(/\/api\/v1\//,async route=>{
  const path=new URL(route.request.url).pathname
  if(path.endsWith('/inventory'))return route.fulfill({json:{extensions:[selected]}})
  if(path.endsWith('/access'))return route.fulfill({json:{extensions:[]}})
  if(path.endsWith('/preview'))return route.fulfill({json:{...JSON.parse(route.request.postData??'{}'),provider:'telegram',revision:'a'.repeat(64),selectionRevision:null,current:selected.record,candidate,addedPermissions:[],addedCapabilities:[]}})
  if(path.endsWith('/select')){commits++;await gate;return route.fulfill({status:400,json:{error:'Failed activation'}})}
  return route.fulfill({status:404,json:{error:'fixture'}})
 })
 try {
  await app.open('/e2e/inventory-harness.html')
  await screen.getByRole('button','Use installed version').click()
  await expect(screen.getByText('Added permissions: None')).toBeVisible()
  await screen.getByRole('button','Confirm selection').click()
  await expect.poll(()=>commits).toBe(1)
  await browser.evaluate(()=>{(Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Refresh fixture inventory') as HTMLButtonElement).click(); return null })
  // Invalidate the review by changing the project, while the POST remains held.
  await browser.keyboard.press('Escape')
  await expect(screen.getByRole('button', 'Confirm selection')).toBeDisabled()
  // A project can change through navigation even while the dialog is modal.
  // The modal blocks real pointers, so the Radix picker is driven by dispatched mouse pointer events.
  await browser.evaluate(() => {
   const fire = (el: Element, type: string) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', pointerId: 1 }))
   fire(document.querySelector('[aria-label="Project access"]')!, 'pointerdown')
   return null
  })
  await expect(screen.getByRole('option', 'Beta app')).toHaveCount(1)
  await browser.evaluate(() => {
   const fire = (el: Element | Document, type: string) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', pointerId: 1 }))
   // The first pointerup after opening is the trigger's own; Radix swallows it.
   fire(document, 'pointerup')
   const option = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent === 'Beta app')!
   fire(option, 'pointerdown'); fire(option, 'pointerup')
   return null
  })
  await expect(screen.getByRole('dialog')).not.toBeVisible()
  await expect(screen.getByRole('button', 'Use installed version')).toBeEnabled()
  await screen.getByRole('combobox', 'Project access').click()
  await screen.getByRole('option', 'Alpha app (current)').click()
  await expect(screen.getByRole('button', 'Use installed version')).toBeDisabled()
  await screen.getByRole('combobox', 'Project access').click()
  await screen.getByRole('option', 'Beta app').click()
  release()
  await expect(screen.getByText('Failed activation')).not.toBeVisible()
  await expect(screen.getByRole('button', 'Use installed version')).toBeEnabled()
  await screen.getByRole('combobox', 'Project access').click()
  await screen.getByRole('option', 'Alpha app (current)').click()
  await expect(screen.getByRole('alert')).toContainText('Failed activation')
  await expect(screen.getByRole('button', 'Use installed version')).toBeEnabled()
  expect(commits).toBe(1)
 } finally {release()}
})
test('unresolved alias waits for identity then retains pending commit and error', async ({app,browser,screen}) => {
 const candidate={...item.record,integrity:'sha512-Yg=='}
 let selected={...item,record:{...item.record,integrity:'sha512-YQ=='},provenance:{kind:'bundled',hostVersion:'1',integrity:'sha512-YQ=='},providers:[{id:'telegram',label:'Telegram'}],installedCandidate:{...item,record:candidate}}
 let commits=0
 let release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 await browser.route(/\/api\/v1\//,async route=>{
  const path=new URL(route.request.url).pathname
  if(path.endsWith('/inventory'))return route.fulfill({json:{extensions:[selected]}})
  if(path.endsWith('/access'))return route.fulfill({json:{extensions:[]}})
  if(path.endsWith('/preview'))return route.fulfill({json:{...JSON.parse(route.request.postData??'{}'),provider:'telegram',revision:'a'.repeat(64),selectionRevision:null,current:selected.record,candidate,addedPermissions:[],addedCapabilities:[]}})
  if(path.endsWith('/select')){commits++;await gate;return route.fulfill({status:400,json:{error:'Failed activation'}})}
  return route.fulfill({status:404,json:{error:'fixture'}})
 })
 try {
  await app.open('/e2e/inventory-harness.html?alias=1')
  await expect(screen.getByText('Waiting for project identity…')).toBeVisible()
  await expect(screen.getByRole('button','Use installed version')).not.toBeVisible()
  expect(commits).toBe(0)
  await browser.evaluate(() => { (window as unknown as {resolveProjectRegistry:()=>void}).resolveProjectRegistry(); return null })
  await screen.getByRole('button','Use installed version').click()
  await expect(screen.getByText('Added permissions: None')).toBeVisible()
  await screen.getByRole('button','Confirm selection').click()
  await expect.poll(()=>commits).toBe(1)
  selected={...selected,record:{...selected.record,status:'failed'}}
  await browser.evaluate(()=>{(Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Refresh fixture inventory') as HTMLButtonElement).click(); return null })
  await expect(screen.getByRole('dialog')).not.toBeVisible()
  const action = screen.getByRole('button','Use installed version')
  if (await action.isEnabled()) {
   await action.click()
   await expect(screen.getByText('Added permissions: None')).toBeVisible()
   await screen.getByRole('button','Confirm selection').click()
   await expect.poll(()=>commits).toBe(2)
  }
  expect(commits,'Only one unresolved selection commit is allowed').toBe(1)
  release()
  await expect(screen.getByRole('alert')).toContainText('Failed activation')
  await expect(action).toBeEnabled()
 } finally {release()}
})
