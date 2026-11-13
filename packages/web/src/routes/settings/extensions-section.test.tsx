import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { ExtensionsSection, extensionSourceLabel, PermissionPreview } from './extensions-section'
import type { ExtensionForm, ExtensionRecord } from '@open-mercato/cezar-api-client'

const health = vi.hoisted(() => ({ current: undefined as unknown, returnTo: null as null | { pathname: string; search: string; hash: string } }))
vi.mock('@/lib/settings-return', () => ({ settingsReturnLocation: () => health.returnTo }))
vi.mock('@/api/client', async () => {
  const { hc } = await import('hono/client')
  return {
    getHealth: async () => { if (!health.current) throw new Error('no health'); return health.current },
    getProjects: async () => ({ bootProject: 'alpha', projectsDir: '/p', projects: [
      { id: 'alpha', name: 'Alpha app', root: '/a', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok' },
      { id: 'beta', name: 'Beta app', root: '/b', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok' },
    ] }),
    cez: hc(''), unwrap: async (response: Response) => {
    const body = await response.json()
    if (!response.ok) throw Object.assign(new Error(body.error), { status: response.status })
    return body
  } }
})
const manifest = { id: 'example', name: 'Example', version: '1.0.0', apiVersion: '0.1' as const, entry: 'index.js', capabilities: ['commands' as const, 'panels' as const, 'forms' as const], permissions: ['project.read' as const], contributes: { forms: [], chatProviders: [], commands: [{ id: 'refresh', label: 'Refresh summary' }], panels: [{ id: 'summary', title: 'Summary', blocks: [], actions: [] }] } }
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); health.current = undefined; health.returnTo = null })
/** The picker's visible choices: open the Radix list from the keyboard and read its options. */
async function projectOptions() {
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Project access' }), { key: 'ArrowDown' })
  const names = (await screen.findAllByRole('option')).map(option => option.textContent)
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  return names
}
const projectValue = () => screen.getByRole('combobox', { name: 'Project access' }).getAttribute('data-value')
function setup(initial: ExtensionRecord[] = [], replaces?: unknown, proposals: unknown[] = [], initialEntry = '/') {
  let records = initial
  let count = 1
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/\?$/, '') // an empty typed query appends a bare `?`
    const off = (health.current as { capabilities?: { extensions?: boolean } } | undefined)?.capabilities?.extensions === false
    let body: unknown
    if ((url.endsWith('/prepare-install') || url.endsWith('/prepare-update'))) body = { preparedId: 'preview-1', manifest, addedPermissions: ['project.read'], addedCapabilities: ['commands'], ...(replaces ? { replaces } : {}) }
    else if (url.endsWith('/commit-install')) { records = [{ manifest, source: '/local/example', installedAt: '', enabled: false }]; body = records[0] }
    else if (url.endsWith('/enable') || url.endsWith('/disable')) { records = records.map(record => ({ ...record, enabled: url.endsWith('/enable') })); body = records[0] }
    else if (url.endsWith('/inventory')) body = { extensions: records.map(record => ({ record, provenance: { kind: 'folder', source: record.source }, availability: record.enabled ? 'available' : 'disabled', selectedVersion: record.manifest.version, management: { enable: !record.enabled && !off, disable: record.enabled && !off, update: !off, uninstall: !off }, providers: (record.manifest.contributes?.chatProviders ?? []).map(provider => ({ id: record.manifest.id + '/' + provider.id, label: provider.label })) })) }
    else if (url.endsWith('/uninstall-impact')) body = { extensionId: 'example', scope: 'all-projects', revision: 'a'.repeat(64), retainsConnectionData: true, projects: [{ projectId: 'beta', name: 'Beta app', enabled: true, providers: ['example/chat'], referencedBy: ['webhook-receiver'] }] }
    else if (init?.method === 'DELETE') { records = []; body = { ok: true } }
    else if (url.endsWith('/invoke')) { count++; body = { ok: true, ...(proposals.length ? { proposals } : {}) } }
    else if (url.endsWith('/panels/summary')) body = { id: 'summary', title: 'Summary', blocks: [{ type: 'status', label: 'Tasks', value: String(count) }], actions: [{ id: 'refresh', label: 'Refresh panel' }] }
    else body = { extensions: records }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[initialEntry]}><ExtensionsSection /></MemoryRouter></QueryClientProvider>)
  // Global settings name the project whose access is shown in a picker.
  return { fetch, client, switchProject: async (name: string | RegExp) => {
    // `hidden`: an open modal dialog marks the page aria-hidden; the switch must still reach it.
    fireEvent.keyDown(document.getElementById('extensions-project-access')!, { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name, hidden: true }))
  } }
}
const record: ExtensionRecord = { manifest, source: '/local/example', installedAt: '', enabled: false }

describe('ExtensionsSection', () => {
  it('names on the consent card exactly the capabilities the manifest declares', () => {
    const { unmount } = render(<PermissionPreview manifest={{ ...manifest, capabilities: ['chatProviders'] }} />)
    expect(screen.getByText('Capabilities: chatProviders')).toBeTruthy()
    unmount()
    render(<PermissionPreview manifest={{ ...manifest, capabilities: [] }} />)
    expect(screen.getByText('Capabilities: None')).toBeTruthy()
  })
  it('counts every contribution kind, so a chat-provider extension does not read as empty', () => {
    const chat = { id: 'chat', name: 'Chat', credentials: [] }
    const form = { id: 'setup', title: 'Setup', fields: [] }
    render(<PermissionPreview manifest={{ ...manifest, contributes: { commands: [], panels: [], forms: [form], chatProviders: [chat] } } as never} />)
    expect(screen.getByText('Contributions: 1 form, 1 chat provider')).toBeTruthy()
  })
  it('labels extension origins without treating a local path as public or bundled', () => {
    expect(extensionSourceLabel({ kind: 'folder', source: 'bundled:telegram' })).toBe('Local extension')
    expect(extensionSourceLabel({ kind: 'folder', source: '/opt/cezar/dist/bundled-chat/slack/index.js' })).toBe('Local extension')
    expect(extensionSourceLabel({ kind: 'npm', source: '@open-mercato/example-chat' })).toBe('Public extension')
    expect(extensionSourceLabel({ kind: 'npm', source: '@open-mercato/example-chat@^1.2.3' })).toBe('Public extension')
    expect(extensionSourceLabel({ kind: 'npm', source: 'example-chat@~1.2.3' })).toBe('Public extension')
    expect(extensionSourceLabel({ kind: 'folder', source: '/home/me/example-chat' })).toBe('Local extension')
  })

  it.each(['/tmp/untrusted/bundled-chat/evil', 'cezar-bundled:telegram', 'C:\\untrusted\\bundled-chat\\evil'])('does not award first-party provenance to a saved source %s', async source => {
    setup([{ ...record, source }])
    await screen.findByText('Local extension')
    expect(screen.queryByText('Shipped with Cezar')).toBeNull()
  })

  it('previews affected projects and submits the reviewed revision', async () => {
    const { fetch } = setup([record])
    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall' }))
    const impact = await screen.findByRole('alertdialog')
    await within(impact).findByText(/Beta app.*Enabled/)
    expect(within(impact).getByText(/Beta app/).textContent).toMatch(/Kept as Missing even if data is deleted: a webhook receiver still uses it/)
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall and keep data' }))
    await waitFor(() => expect(fetch.mock.calls.some(([url, init]) => init?.method === 'DELETE' && String(url).includes('impactRevision=' + 'a'.repeat(64)))).toBe(true))
  })

  it('previews permissions before installation and separately approves project enablement', async () => {
    const { fetch } = setup()
    fireEvent.change(screen.getByLabelText('Extension folder or package'), { target: { value: '/local/example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview install' }))
    const preview = await screen.findByRole('dialog', { name: /Install Example/ })
    expect(within(preview).getByText('Added permissions: project.read')).toBeTruthy()
    expect(within(preview).getByText('Added capabilities: commands')).toBeTruthy()
    expect(within(preview).getByText(/Installing does not enable it for any project/)).toBeTruthy()
    expect(within(preview).getByText(/not a security sandbox/)).toBeTruthy()
    // A hosted cockpit (CEZ_REMOTE_EXTENSIONS=1) runs extensions on the server, not on the viewer's machine.
    expect(within(preview).getByText(/run on the machine that runs Cezar/)).toBeTruthy()
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/commit-install'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Approve and install' }))
    // The install confirms itself and moves focus to the new row, whose Enable is the next step.
    expect((await screen.findByText(/^Installed\. Enable it for .+ to start it\.$/)).getAttribute('role')).toBe('status')
    await waitFor(() => expect(document.activeElement?.id).toBe('extension-example'))
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }))
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/enable'))).toBe(false)
    expect(screen.getByRole('dialog', { name: /Enable Example/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Approve and enable' }))
    await screen.findByRole('button', { name: 'Disable' })
    expect(fetch.mock.calls.find(([url]) => String(url).endsWith('/commit-install'))?.[1]?.body).toBe(JSON.stringify({ preparedId: 'preview-1' }))
  })
  it('renders enabled contributions, invokes commands and refreshes panel snapshots', async () => {
    const { fetch } = setup([{ ...record, enabled: true }])
    await screen.findByText('1')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh panel' }))
    await screen.findByText('2')
    expect(fetch.mock.calls.some(([url]) => String(url) === '/api/v1/p/default/extensions/example/commands/refresh/invoke')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    await screen.findByRole('button', { name: 'Enable' })
    expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull()
  })
  it('prepares reload from the saved source and preserves data on uninstall', async () => {
    const { fetch } = setup([record])
    fireEvent.click(await screen.findByRole('button', { name: 'Reload' }))
    await screen.findByRole('dialog', { name: /Install Example/ })
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/example/prepare-update'))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel install' }))
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Uninstall Example?' })
    expect(within(confirm).getByText(/data are preserved/)).toBeTruthy()
    expect(within(confirm).getByText(/removes the extension from all projects/)).toBeTruthy()
    expect(within(confirm).getByText(/only.*project.*Disable/)).toBeTruthy()
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall and keep data' }))
    await screen.findByText('No extensions installed')
    expect(fetch.mock.calls.find(([, init]) => init?.method === 'DELETE')?.[0]).toBe('/api/v1/extensions/example?impactRevision=' + 'a'.repeat(64) + '&removeData=false')
  })
  it('isolates cache entries and discards pending approval when switching projects', async () => {
    const { fetch, client, switchProject } = setup([record])
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }))
    await switchProject(/^Beta app/)
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url) === '/api/v1/p/beta/extensions/access')).toBe(true))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(client.getQueryData(['extensions', 'default', 'list'])).toBeDefined()
    await waitFor(() => expect(client.getQueryData(['extensions', 'beta', 'list'])).toBeDefined())
  })
  it('shows preparation errors without offering approval', async () => {
    const { fetch } = setup()
    await screen.findByText('No extensions installed')
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'Invalid manifest' }), { status: 400 }))
    fireEvent.change(screen.getByLabelText('Extension folder or package'), { target: { value: '/broken' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview install' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Invalid manifest')
    expect(alert.className).toContain('text-danger')
    expect(screen.queryByRole('button', { name: 'Approve and install' })).toBeNull()
    // Starting another operation clears the stale failure.
    fireEvent.change(screen.getByLabelText('Extension folder or package'), { target: { value: '/local/example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview install' }))
    await screen.findByRole('dialog', { name: /Install Example/ })
    expect(screen.queryByText('Invalid manifest')).toBeNull()
  })
  it('moves focus into the consent dialog when enabling', async () => {
    setup([record])
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }))
    const dialog = await screen.findByRole('dialog', { name: /Enable Example/ })
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  })
  it('never carries the delete-data choice from one uninstall target to the next', async () => {
    const other: ExtensionRecord = { ...record, manifest: { ...manifest, id: 'other', name: 'Other' } }
    setup([record, other])
    const first = await screen.findByRole('listitem', { name: 'Example' })
    fireEvent.click(within(first).getByRole('button', { name: 'Uninstall' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Uninstall Example?' })
    fireEvent.click(within(confirm).getByRole('checkbox'))
    expect(within(confirm).getByRole('button', { name: 'Uninstall and delete data' })).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    fireEvent.click(within(screen.getByRole('listitem', { name: 'Other' })).getByRole('button', { name: 'Uninstall' }))
    const second = await screen.findByRole('alertdialog', { name: 'Uninstall Other?' })
    expect((within(second).getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(within(second).getByRole('button', { name: 'Uninstall and keep data' })).toBeTruthy()
  })
  it('says what a replacement does to the projects running it', async () => {
    setup([record], { version: '0.9.0', sourceChanged: true, keepsConsent: false, enabledProjects: 3 })
    fireEvent.click(await screen.findByRole('button', { name: 'Reload' }))
    const preview = await screen.findByRole('dialog', { name: /Install Example/ })
    expect(within(preview).getByText(/Replaces version 0\.9\.0 from a different source\. It will be disabled in 3 projects until you approve it again\./)).toBeTruthy()
    expect(within(preview).queryByText(/does not enable it/)).toBeNull()
    cleanup()
    setup([record], { version: '0.9.0', sourceChanged: false, keepsConsent: true, enabledProjects: 1 })
    fireEvent.click(await screen.findByRole('button', { name: 'Reload' }))
    expect(within(await screen.findByRole('dialog', { name: /Install Example/ })).getByText(/It stays enabled in 1 project and restarts on this version/)).toBeTruthy()
  })
  it('does not query live forms or panels of a failed worker', async () => {
    const { fetch } = setup([{ ...record, enabled: true, status: 'failed', error: 'extension process exited' }])
    await screen.findByRole('button', { name: 'Disable' })
    expect(fetch.mock.calls.some(([url]) => /\/panels\/|\/forms/.test(String(url)))).toBe(false)
    expect(screen.queryByRole('button', { name: 'Refresh summary' })).toBeNull()
  })
  it('shows the extension status as a labelled pill', async () => {
    setup([{ ...record, enabled: true, status: 'starting' }])
    const row = await screen.findByRole('listitem', { name: 'Example' })
    expect(within(row).getByText('Starting').closest('[data-slot="pill"]')).toBeTruthy()
    expect(within(row).queryByText(/starting/)).toBeNull()
  })
  it('names projects instead of showing raw ids and lists the current project once', async () => {
    setup([])
    await screen.findByRole('combobox', { name: 'Project access' })
    await screen.findByText(/approve access for Alpha app/)
    expect(await projectOptions()).toEqual(['Alpha app (current)', 'Beta app'])
    expect(screen.queryByText(/project default/)).toBeNull()
  })
  it('leaves the page heading to the settings shell and leads with the Project access card', async () => {
    setup([])
    const select = await screen.findByRole('combobox', { name: 'Project access' })
    const heading = screen.getByRole('heading', { name: 'Project access' })
    expect(heading.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryAllByRole('heading', { name: 'Extensions' })).toHaveLength(0)
  })
})

describe('ExtensionsSection — availability and feedback', () => {
  const offHealth = (reason: 'flag_off' | 'hosted') => ({ version: '1', capabilities: { localHandoff: reason !== 'hosted', extensions: false, extensionsUnavailableReason: reason } })
  it.each([['flag_off', /CEZ_EXTENSIONS=0 stops installed extensions/], ['hosted', /Set CEZ_REMOTE_EXTENSIONS=1 on the server/]] as const)('says extensions are off (%s) instead of offering install, enable or run', async (reason, copy) => {
    health.current = offHealth(reason)
    const { fetch } = setup([{ ...record, enabled: true, status: 'running' }, { ...record, manifest: { ...manifest, id: 'other', name: 'Other' }, enabled: false }])
    const note = await screen.findByRole('note')
    expect(note.textContent).toMatch(/Extensions are off on this server/)
    expect(note.textContent).toMatch(copy)
    expect(screen.queryByLabelText('Extension folder or package')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Preview install' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Choose local folder' })).toBeNull()
    const running = await screen.findByRole('listitem', { name: 'Example' })
    expect(within(running).getByText('Enabled · not running')).toBeTruthy()
    expect(within(running).queryByText('Running')).toBeNull()
    for (const name of ['Enable', 'Reload', 'Uninstall', 'Refresh summary']) expect(screen.queryByRole('button', { name })).toBeNull()
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/panels/'))).toBe(false)
    expect(within(running).queryByRole('button', { name: 'Disable' })).toBeNull()
  })
  it('keeps install available when the server reports extensions on', async () => {
    health.current = { version: '1', capabilities: { localHandoff: true, extensions: true } }
    setup()
    expect(await screen.findByRole('button', { name: 'Preview install' })).toBeTruthy()
    expect(screen.queryByText(/Extensions are off/)).toBeNull()
  })
  it('defaults project access to the project the user came from', async () => {
    health.returnTo = { pathname: '/p/beta/tasks', search: '', hash: '' }
    const { fetch } = setup([])
    await screen.findByRole('combobox', { name: 'Project access' })
    await waitFor(() => expect(projectValue()).toBe('beta'))
    expect(await projectOptions()).toEqual(['Alpha app', 'Beta app (current)'])
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url) === '/api/v1/p/beta/extensions/access')).toBe(true))
  })
  it('says where extensions come from when none is installed', async () => {
    setup()
    const empty = (await screen.findByText('No extensions installed')).parentElement!
    expect(empty.textContent).toMatch(/npm package or a built local folder/)
    expect(empty.textContent).toMatch(/@open-mercato\/cezar-extension-sdk/)
  })
  it('renders only Settings-located panels and commands; other placements live in their surfaces', async () => {
    const placed = { ...manifest, contributes: { ...manifest.contributes, commands: [{ id: 'refresh', label: 'Refresh summary', location: 'palette' as const }], panels: [{ id: 'summary', title: 'Summary', blocks: [], actions: [], location: 'task' as const }] } }
    const { fetch } = setup([{ ...record, manifest: placed, enabled: true }])
    await screen.findByRole('listitem', { name: 'Example' })
    expect(screen.queryByRole('button', { name: 'Refresh summary' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull()
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/panels/summary'))).toBe(false)
  })
  it('confirms a command that proposes nothing, in its own row', async () => {
    setup([{ ...record, enabled: true }])
    const row = await screen.findByRole('listitem', { name: 'Example' })
    fireEvent.click(within(row).getByRole('button', { name: 'Refresh summary' }))
    expect((await within(row).findByRole('status')).textContent).toBe('Done. No tasks were proposed.')
    expect(row.querySelector('[aria-live="polite"]')).toBeTruthy()
  })
  it('shows proposals in the producing row, moves focus to them and lets them be dismissed', async () => {
    setup([{ ...record, enabled: true }], undefined, [{ title: 'Fix the flaky test', prompt: 'Fix it' }])
    const row = await screen.findByRole('listitem', { name: 'Example' })
    fireEvent.click(within(row).getByRole('button', { name: 'Refresh summary' }))
    const heading = await within(row).findByRole('heading', { name: 'Proposed task' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(within(row).getByRole('region', { name: 'Proposed task' }).textContent).toMatch(/Fix the flaky test/)
    expect(within(row).getByRole('link', { name: 'Review task before starting' }).getAttribute('href')).toMatch(/^\/p\/default\//)
    fireEvent.click(within(row).getByRole('button', { name: 'Dismiss' }))
    expect(within(row).queryByRole('region', { name: 'Proposed task' })).toBeNull()
  })
})

it.each([false, true])('reconciles a form save when the canonical refetch fails=%s', async failRefresh => {
  const form: ExtensionForm = { id: 'prefs', title: 'Preferences', commandId: 'save', fields: [
    { key: 'name', label: 'Display name', type: 'text', required: false },
    { key: 'token', label: 'Access token', type: 'password', required: false },
  ], values: { name: 'saved' } }
  const { fetch } = setup([{ ...record, enabled: true, manifest: { ...manifest, contributes: { ...manifest.contributes, forms: [form] } } }])
  const other = fetch.getMockImplementation()!
  let saved = false
  fetch.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/forms')) return new Response(JSON.stringify(saved && failRefresh ? { error: 'Refresh unavailable' } : { forms: [form] }), { status: saved && failRefresh ? 503 : 200 })
    if (url.endsWith('/commands/save/invoke')) { saved = true; return new Response(JSON.stringify({ ok: true })) }
    return other(input, init)
  })
  await screen.findByLabelText('Display name')
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: ' SAVED ' } })
  fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'new-secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }))
  if (failRefresh) await screen.findByText('Refresh unavailable')
  await waitFor(() => expect(screen.getByLabelText('Display name')).toHaveProperty('value', failRefresh ? ' SAVED ' : 'saved'))
  await waitFor(() => expect(screen.getByLabelText('Access token')).toHaveProperty('value', ''))
  expect(screen.getByRole('button', { name: 'Save Preferences' })).toHaveProperty('disabled', false)
})

it('honors the project in a Manage extension link', async () => {
  const { fetch } = setup([record], undefined, [], '/settings/global/extensions?project=beta&extension=example')
  await waitFor(() => expect(projectValue()).toBe('beta'))
  expect(fetch.mock.calls.some(([url]) => String(url) === '/api/v1/p/beta/extensions/access')).toBe(true)
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('listitem', { name: 'Example' })))
})

it('maps a linked boot project to its single selector option', async () => {
  setup([record], undefined, [], '/settings/global/extensions?project=alpha&extension=example')
  await waitFor(() => expect(projectValue()).toBe('default'))
})
it('does not claim an empty off-server response proves nothing is installed', async () => {
  health.current = { capabilities: { extensions: false, extensionsUnavailableReason: 'flag_off' } }
  setup([])
  await screen.findByText('Extension inventory unavailable')
  expect(screen.queryByText('No extensions installed')).toBeNull()
})

it('refreshes a stale impact and requires renewed confirmation without retrying DELETE', async () => {
  const { fetch } = setup([record])
  fireEvent.click(await screen.findByRole('button', { name: 'Uninstall' }))
  await screen.findByText(/Beta app.*Enabled/)
  const original = fetch.getMockImplementation()!
  let deletes = 0
  fetch.mockImplementation(async (input, init) => {
    if (init?.method === 'DELETE') { deletes++; return new Response(JSON.stringify({ error: 'Impact changed' }), { status: 409 }) }
    if (String(input).endsWith('/uninstall-impact')) return new Response(JSON.stringify({
      extensionId: 'example', scope: 'all-projects', revision: 'b'.repeat(64), retainsConnectionData: true,
      projects: [{ projectId: 'gamma', name: 'Gamma app', enabled: true, providers: ['example/chat'] }],
    }))
    return original(input, init)
  })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Uninstall and delete data' }))
  await screen.findByText(/Gamma app.*Enabled/)
  expect(screen.getByRole('alert').textContent).toContain('confirm again')
  expect(deletes).toBe(1)
  expect(screen.getByRole('checkbox')).toHaveProperty('checked', false)
  fireEvent.click(screen.getByRole('button', { name: 'Uninstall and keep data' }))
  await waitFor(() => expect(deletes).toBe(2))
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')[1]?.[0]).toContain('impactRevision=' + 'b'.repeat(64))
})

it('ignores a late impact response after a project switch', async () => {
  const { fetch, switchProject } = setup([record])
  const original = fetch.getMockImplementation()!
  let resolve!: (value: Response) => void
  fetch.mockImplementation((input, init) => String(input).endsWith('/uninstall-impact')
    ? new Promise<Response>(done => { resolve = done }) : original(input, init))
  fireEvent.click(await screen.findByRole('button', { name: 'Uninstall' }))
  await screen.findByText('Loading affected projects…')
  expect(screen.getByRole('button', { name: 'Uninstall and keep data' })).toHaveProperty('disabled', true)
  await switchProject(/^Beta app/)
  resolve(new Response(JSON.stringify({ extensionId: 'example', scope: 'all-projects', revision: 'a'.repeat(64), projects: [], retainsConnectionData: true })))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
})

it('retains passive missing declarations with host provenance and no active access', async () => {
  const { fetch, client } = setup()
  const original = fetch.getMockImplementation()!
  await screen.findByText('No extensions installed')
  fetch.mockImplementation(async (input, init) => String(input).endsWith('/inventory') ? new Response(JSON.stringify({
    extensions: [{ record: { ...record, source: 'not-a-bundled-path' }, provenance: { kind: 'bundled', hostVersion: '1', integrity: 'digest' }, availability: 'missing', selectedVersion: '2.0.0', management: { enable: false, disable: false, update: false, uninstall: false }, providers: [] }],
  })) : original(input, init))
  await client.invalidateQueries({ queryKey: ['extensions', 'default', 'inventory'] })
  await screen.findByText('Shipped with Cezar')
  expect(screen.getByText('Missing')).toBeTruthy()
  expect(screen.getByText('2.0.0')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull()
  expect(screen.queryByText(/keeps its approval/)).toBeNull()
})

it('explains an uninstalled extension row that the project still approves', async () => {
  const { fetch, client } = setup()
  const original = fetch.getMockImplementation()!
  await screen.findByText('No extensions installed')
  fetch.mockImplementation(async (input, init) => String(input).endsWith('/inventory') ? new Response(JSON.stringify({
    extensions: [{ record, provenance: { kind: 'folder', source: record.source }, availability: 'missing', selectedVersion: '1.0.0', management: { enable: false, disable: false, update: false, uninstall: false }, providers: [] }],
  })) : original(input, init))
  await client.invalidateQueries({ queryKey: ['extensions', 'default', 'inventory'] })
  expect((await screen.findByText(/keeps its approval/)).textContent).toMatch(/install it again, then Uninstall/)
})

it('blocks uninstall when impact loading fails and allows a fresh preview retry', async () => {
  const { fetch } = setup([record])
  const original = fetch.getMockImplementation()!
  let fail = true
  fetch.mockImplementation(async (input, init) => String(input).endsWith('/uninstall-impact') && fail
    ? new Response(JSON.stringify({ error: 'Preview unavailable' }), { status: 503 }) : original(input, init))
  fireEvent.click(await screen.findByRole('button', { name: 'Uninstall' }))
  await screen.findByText('Preview unavailable')
  expect(screen.getByRole('button', { name: 'Uninstall and keep data' })).toHaveProperty('disabled', true)
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry impact preview' }))
  await screen.findByText(/Beta app.*Enabled/)
  expect(screen.getByRole('button', { name: 'Uninstall and keep data' })).toHaveProperty('disabled', false)
})

it('offers a named keyboard-focusable uninstall review region separate from actions', async () => {
  setup([record])
  fireEvent.click(await screen.findByRole('button', { name: 'Uninstall' }))
  await screen.findByText(/Beta app.*Enabled/)
  const review = screen.getByRole('region', { name: 'Uninstall impact' })
  expect(review.tabIndex).toBe(0)
  expect(within(review).getByText(/Beta app.*Enabled/)).toBeTruthy()
  expect(within(review).queryByRole('button', { name: 'Cancel' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Cancel' })).toBe(document.activeElement)
})

async function inventoryOnly(item: unknown) {
  const state = setup()
  await screen.findByText(/No extensions installed|Extension inventory unavailable/)
  const original = state.fetch.getMockImplementation()!
  state.fetch.mockImplementation(async (input, init) => String(input).endsWith('/inventory')
    ? new Response(JSON.stringify({ extensions: [item] })) : original(input, init))
  await state.client.invalidateQueries({ queryKey: ['extensions', 'default', 'inventory'] })
  return state
}
const selected = { record, provenance: { kind: 'bundled', hostVersion: '1', integrity: 'digest' }, availability: 'disabled', selectedVersion: '1.0.0', management: { enable: true, disable: false, update: false, uninstall: false }, providers: [{ id: 'telegram', label: 'Telegram' }] }
it('uses shipped inventory permissions without access even with extensions off', async () => {
  health.current = { capabilities: { extensions: false, extensionsUnavailableReason: 'flag_off' } }
  await inventoryOnly(selected)
  expect((await screen.findByRole('link', { name: /Telegram/ })).getAttribute('href')).toContain('integration=telegram')
  fireEvent.click(await screen.findByRole('button', { name: 'Enable' }))
  expect(screen.getByRole('button', { name: 'Approve and enable' })).toHaveProperty('disabled', false)
  expect(screen.queryByRole('button', { name: 'Uninstall' })).toBeNull()
})
it('separates inactive installed candidate management from selected shipped implementation', async () => {
  const candidate = { ...selected, record: { ...record, source: '/installed/example', manifest: { ...manifest, version: '2.0.0' } }, provenance: { kind: 'folder', source: '/installed/example' }, selectedVersion: '2.0.0', management: { enable: false, disable: false, update: true, uninstall: true } }
  const { fetch } = await inventoryOnly({ ...selected, installedCandidate: candidate })
  const region = await screen.findByRole('region', { name: 'Inactive installed candidate' })
  expect(within(region).getByText('2.0.0')).toBeTruthy()
  expect(within(region).queryByRole('button', { name: /Enable|Disable|Adopt/ })).toBeNull()
  fireEvent.click(within(region).getByRole('button', { name: 'Reload' }))
  await screen.findByRole('dialog', { name: /Install Example/ })
  expect(screen.getByText('Source: /installed/example')).toBeTruthy()
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/example/prepare-update'))).toBe(true)
})
it('revokes an open enable approval when fresh inventory removes eligibility', async () => {
  const { client, fetch } = await inventoryOnly(selected)
  fireEvent.click(await screen.findByRole('button', { name: 'Enable' }))
  client.setQueryData(['extensions', 'default', 'inventory'], { extensions: [{ ...selected, management: { ...selected.management, enable: false } }] })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Approve and enable' })).toHaveProperty('disabled', true))
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/enable'))).toBe(false)
})

it.each(['update', 'uninstall'] as const)('revokes an open candidate %s when inventory changes', async action => {
  const candidate = { ...selected, provenance: { kind: 'folder', source: record.source }, management: { enable: false, disable: false, update: true, uninstall: true } }
  const { client, fetch } = await inventoryOnly({ ...selected, installedCandidate: candidate })
  const region = await screen.findByRole('region', { name: 'Inactive installed candidate' })
  fireEvent.click(within(region).getByRole('button', { name: action === 'update' ? 'Reload' : 'Uninstall' }))
  const name = action === 'update' ? 'Approve and install' : 'Uninstall and keep data'
  await waitFor(() => expect(screen.getByRole('button', { name })).toHaveProperty('disabled', false))
  client.setQueryData(['extensions', 'default', 'inventory'], { extensions: [{ ...selected, installedCandidate: { ...candidate, management: { ...candidate.management, [action]: false } } }] })
  await waitFor(() => expect(screen.getByRole('button', { name })).toHaveProperty('disabled', true))
  expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith('/commit-install') || init?.method === 'DELETE')).toBe(false)
})

it('labels the selected implementation only for a chat adapter with an installed candidate', async () => {
  const candidate = { ...selected, provenance: { kind: 'folder', source: record.source }, management: { enable: false, disable: false, update: true, uninstall: true } }
  await inventoryOnly({ ...selected, installedCandidate: candidate })
  expect(await screen.findByText('Selected implementation')).toBeTruthy()
})
it('does not label a plain extension row as a selected implementation', async () => {
  await inventoryOnly({ ...selected, providers: [] })
  await screen.findByRole('button', { name: 'Enable' })
  expect(screen.queryByText('Selected implementation')).toBeNull()
})
