import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { ProjectExtensions } from './extensions-section'
import type { ExtensionInventoryItem } from '@open-mercato/cezar-api-client'
const policy = vi.hoisted(() => ({ bootProject: 'alpha' as string | undefined, off: undefined as 'hosted' | 'flag_off' | undefined }))
vi.mock('@/api/queries', () => ({ useHealth: () => ({ data: { capabilities: { extensions: !policy.off, extensionsUnavailableReason: policy.off } } }), useProjects: () => ({ data: { bootProject: policy.bootProject, projects: [{ id: 'alpha', name: 'Alpha' }] } }) }))
vi.mock('@/api/ws', () => ({ subscribeTopic: () => () => {} }))
vi.mock('@/api/client', async () => {
  const { hc } = await import('hono/client')
  return { cez: hc(''), unwrap: async (r: Response) => { const b = await r.json(); if (!r.ok) throw Object.assign(new Error(b.error), { status: r.status }); return b } }
})
const record = { manifest: { id: 'chat-package', name: 'Telegram', version: '1.0.0', apiVersion: '0.1' as const, entry: 'index.js', capabilities: [], permissions: [] }, source: 'shipped-source', installedAt: '', enabled: false, integrity: 'sha512-YQ==' }
const item: ExtensionInventoryItem = { record, selectedVersion: '1.0.0', provenance: { kind: 'bundled', hostVersion: '1', integrity: record.integrity }, availability: 'disabled', management: { enable: true, disable: false, update: false, uninstall: false }, providers: [{ id: 'telegram', label: 'Telegram' }],
 installedCandidate: { record: { ...record, source: '/candidate', integrity: 'sha512-Yg==', manifest: { ...record.manifest, version: '2.0.0', contributes: { chatProviders: [{ id: 'telegram', label: 'Telegram', receiveModel: 'ordered', commandPrefix: '/', groupPrefix: '', discoveryUrl: 'https://example.test', credentials: [], limits: { maxText: 4000, buttonsPerMessage: 5, perChatPerSecond: 1, perBotPerSecond: 10 } }], commands: [], panels: [], forms: [] } } }, selectedVersion: '2.0.0', provenance: { kind: 'folder', source: '/candidate' }, availability: 'disabled', management: { enable: false, disable: false, update: true, uninstall: true }, providers: [{ id: 'chat-package/telegram', label: 'Telegram' }] } }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); policy.off = undefined; policy.bootProject = 'alpha' })
function setup(fail = 0, installed = false, previewGate?: Promise<void>, initialProject = 'alpha') {
 let current = structuredClone(item)
 if (installed) current = { ...current, record: { ...record, source: '/old-pin' }, provenance: { kind: 'folder', source: '/old-pin' } }
 const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
  const path = String(url)
  if (path.endsWith('/preview') && previewGate) await previewGate
  const input = init?.body ? JSON.parse(String(init.body)) : {}
  if (path.endsWith('/select') && fail) return new Response(JSON.stringify({ error: fail === 400 ? 'Preview changed; review again' : 'Policy disallows selection; previous implementation restored' }), { status: fail })
  const body = path.endsWith('/inventory') ? { extensions: [current] } : path.endsWith('/preview') || path.endsWith('/select') ? { ...input, provider: 'telegram', revision: 'a'.repeat(64), selectionRevision: null, current: current.record, candidate: input.target?.kind === 'shipped' ? record : item.installedCandidate!.record, addedPermissions: [], addedCapabilities: [] } : { extensions: [] }
  return new Response(JSON.stringify(body))
 })
 vi.stubGlobal('fetch', fetch)
 const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
 const view = (id: string) => <QueryClientProvider client={client}><MemoryRouter><ProjectExtensions key={id} projectId={id} /></MemoryRouter></QueryClientProvider>
 const rendered = render(view(initialProject))
 return { fetch, client, navigate: (id: string) => rendered.rerender(view(id)), switchProject: () => rendered.rerender(view('beta')), rerender: () => rendered.rerender(view(initialProject)), candidateChange: () => { current = { ...current, installedCandidate: { ...current.installedCandidate!, record: { ...current.installedCandidate!.record, manifest: { ...current.installedCandidate!.record.manifest, permissions: ['project.read'] } } } }; return client.invalidateQueries({ queryKey: ['extensions'] }) }, change: () => { current = { ...current, record: { ...current.record, enabled: true } }; return client.invalidateQueries({ queryKey: ['extensions'] }) } }
}
it('previews adoption, cancels without mutation, preserves disabled and guards double click', async () => {
 const { fetch } = setup()
 const action = await screen.findByRole('button', { name: 'Use installed version' })
 expect(fetch.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(0)
 fireEvent.click(action)
 await screen.findByText('Added permissions: None')
 fireEvent.click(screen.getByRole('button', { name: 'Cancel selection' }))
 expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/select'))).toBe(false)
 fireEvent.click(action)
 await screen.findByText('Added permissions: None')
 const confirm = screen.getByRole('button', { name: 'Confirm selection' })
 fireEvent.click(confirm); fireEvent.click(confirm)
 await waitFor(() => expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('/select'))).toHaveLength(1))
 expect(JSON.parse(String(fetch.mock.calls.find(([u]) => String(u).endsWith('/select'))![1]!.body))).toMatchObject({ enabled: false, revision: 'a'.repeat(64), target: { kind: 'installed', localProviderId: 'telegram', integrity: 'sha512-Yg==' } })
})
it.each([400, 409])('invalidates rejected preview %s without retrying mutation', async code => {
 const { fetch } = setup(code)
 fireEvent.click(await screen.findByRole('button', { name: 'Use installed version' }))
 await screen.findByText('Added permissions: None')
 fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }))
 await screen.findByRole('alert')
 expect((screen.getByRole('button', { name: 'Confirm selection' }) as HTMLButtonElement).disabled).toBe(true)
 fireEvent.click(screen.getByRole('button', { name: 'Review again' }))
 await screen.findByText('Added permissions: None')
 expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('/select'))).toHaveLength(1)
})
it('offers pin update and explicit return to shipped for selected installed provider', async () => {
 const { fetch } = setup(0, true)
 fireEvent.click(await screen.findByRole('button', { name: 'Return to version shipped with Cezar' }))
 await screen.findByText('Added permissions: None')
 fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }))
 await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/select'))).toBe(true))
 expect(JSON.parse(String(fetch.mock.calls.find(([u]) => String(u).endsWith('/select'))![1]!.body)).target).toEqual({ kind: 'shipped' })
 expect(screen.getByRole('button', { name: 'Use installed version' })).toBeTruthy()
})
it('drops confirmation on changed inventory or project', async () => {
 const { fetch, change, switchProject } = setup()
 fireEvent.click(await screen.findByRole('button', { name: 'Use installed version' }))
 await screen.findByText('Added permissions: None')
 await change()
 await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
 fireEvent.click(screen.getByRole('button', { name: 'Use installed version' }))
 await screen.findByText('Added permissions: None')
 switchProject()
 await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
 expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/select'))).toBe(false)
})

it.each(['hosted', 'flag_off'] as const)('disallows installed selection under %s and asks the server about shipped compatibility', async off => {
 policy.off = off
 const { fetch } = setup(409, true)
 await screen.findByText('Inactive installed candidate')
 expect(screen.queryByRole('button', { name: 'Use installed version' })).toBeNull()
 const shipped = screen.queryByRole('button', { name: 'Return to version shipped with Cezar' })
 if (off === 'hosted') expect(shipped).toBeNull()
 else {
  fireEvent.click(shipped!)
  await screen.findByText('Added permissions: None')
  fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }))
  await screen.findByText(/Policy disallows selection/)
 }
 expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('/select'))).toHaveLength(off === 'hosted' ? 0 : 1)
})
it('invalidates review when candidate permissions or cockpit policy change', async () => {
 const { fetch, candidateChange, rerender } = setup()
 fireEvent.click(await screen.findByRole('button', { name: 'Use installed version' }))
 await screen.findByText('Added permissions: None')
 await candidateChange()
 await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
 fireEvent.click(screen.getByRole('button', { name: 'Use installed version' }))
 await screen.findByText('Added permissions: None')
 policy.off = 'hosted'; rerender()
 expect(screen.queryByRole('dialog')).toBeNull()
 expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/select'))).toBe(false)
})
it.each(['cancel', 'project'] as const)('aborts and drops late preview after %s', async action => {
 let resolve!: () => void
 const gate = new Promise<void>(done => { resolve = done })
 const { fetch, switchProject } = setup(0, false, gate)
 fireEvent.click(await screen.findByRole('button', { name: 'Use installed version' }))
 await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/preview'))).toBe(true))
 const signal = fetch.mock.calls.find(([u]) => String(u).endsWith('/preview'))![1]!.signal!
 if (action === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel selection' }))
 else switchProject()
 expect(signal.aborted).toBe(true)
 resolve()
 await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
 expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/select'))).toBe(false)
})

it('updates the pin only after explicit confirmation of the installed candidate', async () => {
 const { fetch } = setup(0, true)
 fireEvent.click(await screen.findByRole('button', { name: 'Use installed version' }))
 await screen.findByText('Current source: /old-pin · Version: 1.0.0')
 await screen.findByText('Target source: /candidate · Version: 2.0.0')
 expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/select'))).toBe(false)
 fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }))
 await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/select'))).toBe(true))
 expect(JSON.parse(String(fetch.mock.calls.find(([u]) => String(u).endsWith('/select'))![1]!.body))).toMatchObject({ target: { kind: 'installed', integrity: 'sha512-Yg==' }, enabled: false })
})

it('never permits confirmation when the server refuses the read-only preview', async () => {
 const { fetch } = setup()
 await screen.findByRole('button', { name: 'Use installed version' })
 const original = fetch.getMockImplementation()!
 fetch.mockImplementation(async (url, init) => String(url).endsWith('/preview')
  ? new Response(JSON.stringify({ error: 'Candidate identity is incompatible' }), { status: 409 })
  : original(url, init))
 fireEvent.click(screen.getByRole('button', { name: 'Use installed version' }))
 await screen.findByText('Candidate identity is incompatible')
 expect((screen.getByRole('button', { name: 'Confirm selection' }) as HTMLButtonElement).disabled).toBe(true)
 expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/select'))).toBe(false)
})

it('permits disabled recovery even if a missing artifact retains an old enabled approval', async () => {
 const { fetch } = setup(0, true)
 await screen.findByRole('button', { name: 'Return to version shipped with Cezar' })
 const original = fetch.getMockImplementation()!
 fetch.mockImplementation(async (url, init) => {
  const response = await original(url, init)
  if (!String(url).endsWith('/preview')) return response
  const body = await response.json()
  return new Response(JSON.stringify({ ...body, current: { ...body.current, enabled: true } }))
 })
 fireEvent.click(screen.getByRole('button', { name: 'Return to version shipped with Cezar' }))
 await screen.findByText('Current approval: Enabled')
 fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }))
 await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/select'))).toBe(true))
 expect(JSON.parse(String(fetch.mock.calls.find(([u]) => String(u).endsWith('/select'))![1]!.body)).enabled).toBe(false)
})

it('inventory updates cannot forget an unresolved commit and allow another submit', async () => {
 const { fetch, candidateChange } = setup()
 await screen.findByRole('button', { name: 'Use installed version' })
 const original = fetch.getMockImplementation()!
 let release!: () => void
 const gate = new Promise<void>(resolve => { release = resolve })
 fetch.mockImplementation(async (url, init) => {
  if (String(url).endsWith('/select')) await gate
  return original(url, init)
 })
 fireEvent.click(screen.getByRole('button', { name: 'Use installed version' }))
 await screen.findByText('Added permissions: None')
 fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }))
 await waitFor(() => expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('/select'))).toHaveLength(1))
 await candidateChange()
 await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
 // If review was retired, a new action must remain blocked until the outstanding mutation settles.
 const action = screen.getByRole('button', { name: 'Use installed version' })
 if (!screen.queryByRole('dialog') && !(action as HTMLButtonElement).disabled) {
  fireEvent.click(action)
  await screen.findByText('Added permissions: None')
  fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }))
 }
 release()
 expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('/select'))).toHaveLength(1)
})

it.each(['candidate', 'inventory', 'policy', 'project'] as const)('retains pending ownership and originating error across %s changes', async changeKind => {
 const { fetch, candidateChange, change, switchProject, rerender } = setup()
 await screen.findByRole('button', { name: 'Use installed version' })
 const original = fetch.getMockImplementation()!
 let release!: () => void
 const gate = new Promise<void>(resolve => { release = resolve })
 fetch.mockImplementation(async (url, init) => {
  if (String(url).endsWith('/select')) {
   await gate
   return new Response(JSON.stringify({ error: 'Origin activation failed' }), { status: 409 })
  }
  return original(url, init)
 })
 fireEvent.click(screen.getByRole('button', { name: 'Use installed version' }))
 await screen.findByText('Added permissions: None')
 fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }))
 if (changeKind === 'candidate') await candidateChange()
 if (changeKind === 'inventory') await change()
 if (changeKind === 'policy') { policy.off = 'hosted'; rerender(); policy.off = undefined; rerender() }
 if (changeKind === 'project') { switchProject(); await screen.findByRole('button', { name: 'Use installed version' }); rerender() }
 await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
 expect((screen.getByRole('button', { name: 'Use installed version' }) as HTMLButtonElement).disabled).toBe(true)
 // Settlement while another project is visible must stay with the origin.
 switchProject()
 await screen.findByRole('button', { name: 'Use installed version' })
 release()
 expect(screen.queryByText('Origin activation failed')).toBeNull()
 rerender()
 await screen.findByText('Origin activation failed')
 expect((screen.getByRole('button', { name: 'Use installed version' }) as HTMLButtonElement).disabled).toBe(false)
 expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('/select'))).toHaveLength(1)
})

it('retains successful settlement for origin without closing another project review', async () => {
 const { fetch, client, switchProject, rerender } = setup()
 await screen.findByRole('button', { name: 'Use installed version' })
 const original = fetch.getMockImplementation()!
 let release!: () => void
 const gate = new Promise<void>(resolve => { release = resolve })
 fetch.mockImplementation(async (url, init) => {
  if (String(url).endsWith('/select')) await gate
  return original(url, init)
 })
 fireEvent.click(screen.getByRole('button', { name: 'Use installed version' }))
 await screen.findByText('Added permissions: None')
 fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }))
 switchProject()
 fireEvent.click(await screen.findByRole('button', { name: 'Use installed version' }))
 await screen.findByText('Added permissions: None')
 const betaInventoryReads = fetch.mock.calls.filter(([u]) => String(u).includes('/beta/') && String(u).endsWith('/inventory')).length
 release()
 await waitFor(() => expect(client.getQueryState(['extensions', 'alpha', 'inventory'])?.isInvalidated).toBe(true))
 expect(screen.getByRole('dialog').textContent).toContain('for beta')
 expect(screen.queryByText('Selected the Telegram implementation for Alpha.')).toBeNull()
 expect(fetch.mock.calls.filter(([u]) => String(u).includes('/beta/') && String(u).endsWith('/inventory'))).toHaveLength(betaInventoryReads)
 rerender()
 await screen.findByText('Selected the Telegram implementation for Alpha.')
 expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('/select'))).toHaveLength(1)
})

it('waits for a reliable default identity before offering any selection or preview', async () => {
 policy.bootProject = undefined
 const { fetch, navigate } = setup(0, true, undefined, 'default')
 await screen.findByText('Waiting for project identity…')
 expect(screen.queryByRole('button', { name: 'Use installed version' })).toBeNull()
 expect(screen.queryByRole('button', { name: 'Return to version shipped with Cezar' })).toBeNull()
 expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
 policy.bootProject = 'alpha'; navigate('default')
 fireEvent.click(await screen.findByRole('button', { name: 'Use installed version' }))
 await screen.findByText('Added permissions: None')
 expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('/select'))).toHaveLength(0)
 expect(String(fetch.mock.calls.find(([u]) => String(u).endsWith('/preview'))![0])).toContain('/alpha/')
})

it.each(['success', 'error'] as const)('keeps %s at the resolved origin across equivalent alias navigation and registry loss', async outcome => {
 const { fetch, client, navigate, candidateChange } = setup(0, false, undefined, 'default')
 await screen.findByRole('button', { name: 'Use installed version' })
 const original = fetch.getMockImplementation()!
 let release!: () => void
 const gate = new Promise<void>(resolve => { release = resolve })
 fetch.mockImplementation(async (url, init) => {
  if (String(url).endsWith('/select')) {
   await gate
   if (outcome === 'error') return new Response(JSON.stringify({ error: 'Origin activation failed' }), { status: 409 })
  }
  return original(url, init)
 })
 try {
  fireEvent.click(screen.getByRole('button', { name: 'Use installed version' }))
  await screen.findByText('Added permissions: None')
  fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }))
  await waitFor(() => expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('/select'))).toHaveLength(1))
  expect(String(fetch.mock.calls.find(([u]) => String(u).endsWith('/select'))![0])).toContain('/alpha/')
  policy.bootProject = undefined; navigate('default')
  await screen.findByText('Waiting for project identity…')
  navigate('alpha')
  await waitFor(() => expect((screen.getByRole('button', { name: 'Use installed version' }) as HTMLButtonElement).disabled).toBe(true))
  policy.bootProject = 'alpha'; navigate('default')
  await candidateChange()
  expect((screen.getByRole('button', { name: 'Use installed version' }) as HTMLButtonElement).disabled).toBe(true)
  navigate('beta')
  fireEvent.click(await screen.findByRole('button', { name: 'Use installed version' }))
  await screen.findByText('Added permissions: None')
  release()
  await waitFor(() => expect(client.getQueryData(['chat-selection-commit', 'alpha', 'telegram'])).toMatchObject({ status: outcome }))
  expect(screen.getByRole('dialog').textContent).toContain('for beta')
  navigate('alpha')
  const message = outcome === 'error' ? 'Origin activation failed' : 'Selected the Telegram implementation for Alpha.'
  await screen.findByText(message)
  navigate('default')
  await screen.findByText(message)
  expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('/select'))).toHaveLength(1)
 } finally { release() }
})

it('lets the user dismiss a settled outcome and names the provider by its label', async () => {
 const { fetch } = setup()
 fireEvent.click(await screen.findByRole('button', { name: 'Use installed version' }))
 expect(await screen.findByRole('heading', { name: 'Select the Telegram implementation for Alpha' })).toBeTruthy()
 await screen.findByText('Added permissions: None')
 fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }))
 await screen.findByText('Selected the Telegram implementation for Alpha.')
 fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
 await waitFor(() => expect(screen.queryByText('Selected the Telegram implementation for Alpha.')).toBeNull())
 expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('/select'))).toHaveLength(1)
})

it('shows nothing, not a project-identity wait, for an extension without a chat provider', async () => {
 policy.bootProject = undefined
 const plain = { ...structuredClone(item), providers: [], installedCandidate: undefined, record: { ...record, manifest: { ...record.manifest, id: 'plain', name: 'Plain' } } }
 vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(JSON.stringify(String(url).endsWith('/inventory') ? { extensions: [plain] } : { extensions: [] }))))
 const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
 render(<QueryClientProvider client={client}><MemoryRouter><ProjectExtensions projectId="default" /></MemoryRouter></QueryClientProvider>)
 await screen.findByText('Plain')
 expect(screen.queryByText('Waiting for project identity…')).toBeNull()
})
