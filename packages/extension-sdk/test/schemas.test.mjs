import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as sdk from '../dist/index.js'
import { extensionManifestSchema, extensionTaskNotificationSchema, defineExtension, EXTENSION_API_VERSION, EXTENSION_API_VERSIONS } from '../dist/index.js'

const base = { id: 'example', name: 'Example', version: '1', apiVersion: '0.1', entry: 'index.js', capabilities: [] }
test('a minimal manifest parses to its normalized shape', () => {
  assert.deepEqual(extensionManifestSchema.parse(base), { ...base, permissions: [] })
})
test('required fields are required and unknown top-level keys are refused', () => {
  const { entry, capabilities, ...rest } = base
  assert.equal(extensionManifestSchema.safeParse({ ...rest, capabilities }).success, false)
  assert.equal(extensionManifestSchema.safeParse({ ...rest, entry }).success, false)
  for (const patch of [
    { unknown: true }, { permissions: ['tasks.read'] },
    { capabilities: ['commands'], contributes: { commands: [{ id: 'x', title: 'X' }] } },
  ]) assert.equal(extensionManifestSchema.safeParse({ ...base, ...patch }).success, false, JSON.stringify(patch))
})
test('unknown capabilities, versions and permissions fail closed', () => {
  for (const patch of [
    { capabilities: ['chat'] }, { capabilities: ['runners'] },
    { permissions: ['tasks.write'] }, { apiVersion: '0.2' },
    { capabilities: ['commands'], contributes: { commands: [{ id: 'x' }] } }, { entry: undefined },
    { entry: '/tmp/index.js' },
  ]) assert.equal(extensionManifestSchema.safeParse({ ...base, ...patch }).success, false)
})
test('duplicate contribution ids are still rejected', () => {
  assert.equal(extensionManifestSchema.safeParse({
    ...base, capabilities: ['commands'],
    contributes: { commands: [{ id: 'x', label: 'X' }, { id: 'x', label: 'X again' }] },
  }).success, false)
})
test('lifecycle definitions are preserved', () => {
  const definition = { activate() { return { dispose() {} } }, deactivate() {} }
  assert.equal(defineExtension(definition), definition)
})

test('resync notifications preserve the existing task event shape', () => {
  assert.deepEqual(extensionTaskNotificationSchema.parse({ type: 'resyncRequired' }), { type: 'resyncRequired' })
  assert.equal(extensionTaskNotificationSchema.safeParse({ type: 'resyncRequired', task: {} }).success, false)
  assert.equal(extensionTaskNotificationSchema.parse({ type: 'created', sequence: 1, task: { id: '1', title: 'Task', status: 'queued' } }).type, 'created')
})

test('apiVersion accepts exactly the supported list', () => {
  assert.deepEqual(EXTENSION_API_VERSIONS, ['0.1'])
  assert.equal(EXTENSION_API_VERSION, '0.1')
  for (const apiVersion of EXTENSION_API_VERSIONS) assert.equal(extensionManifestSchema.parse({ ...base, apiVersion }).apiVersion, apiVersion)
  for (const apiVersion of ['0.0', '1.0', 0.1]) assert.equal(extensionManifestSchema.safeParse({ ...base, apiVersion }).success, false)
})

test('host HTTP and IPC shapes stay out of the public surface', () => {
  for (const name of ['extensionRecordSchema', 'extensionsResponseSchema', 'installExtensionInputSchema', 'extensionUninstallQuerySchema',
    'extensionFormsResponseSchema', 'extensionRpcRequestSchema', 'extensionRpcResponseSchema', 'extensionRpcReadySchema',
    'extensionHostRequestSchema', 'extensionStorageSetSchema', 'extensionChatCallSchema']) assert.equal(name in sdk, false, name)
  for (const name of ['extensionManifestSchema', 'extensionPanelSchema', 'extensionFormSchema', 'extensionChatProviderSchema',
    'chatEventSchema', 'validateExtensionForm', 'ExtensionChatError', 'defineExtension']) assert.equal(name in sdk, true, name)
})

test('a chat provider must declare its receive model', () => {
  const provider = { id: 'chat', label: 'Chat', credentials: [{ name: 'token', label: 'Token' }], discoveryUrl: 'https://example.com',
    limits: { maxText: 1000, buttonsPerMessage: 0, perChatPerSecond: 1, perBotPerSecond: 1 } }
  assert.equal(sdk.extensionChatProviderSchema.safeParse(provider).success, false)
  assert.equal(sdk.extensionChatProviderSchema.parse({ ...provider, receiveModel: 'ordered' }).receiveModel, 'ordered')
})

test('chat message events carry the pairing eligibility decision', () => {
  const event = { kind: 'message', id: 'e', messageId: 'm', chat: { id: 'c', kind: 'private' },
    user: { id: 'u', label: 'User' }, at: 1, text: 'hello', addressed: true, pairingEligible: false }
  assert.equal(sdk.chatEventSchema.parse(event).pairingEligible, false)
})

test('only permissions that gate a host API are accepted', () => {
  assert.deepEqual(extensionManifestSchema.parse({ ...base, permissions: ['project.read', 'task.create'] }).permissions, ['project.read', 'task.create'])
  assert.equal(extensionManifestSchema.safeParse({ ...base, permissions: ['project.write'] }).success, false)
})

// Placements: spec 2026-11-07-extension-placements.
const placed = {
  ...base, capabilities: ['commands', 'panels'],
  contributes: {
    panels: [{ id: 'side', title: 'Side', location: 'sidebar' }, { id: 'task', title: 'Task', location: 'task' }, { id: 'plain', title: 'Plain' }],
    commands: [{ id: 'pal', label: 'Palette', location: 'palette' }, { id: 'tsk', label: 'Task', location: 'task' }, { id: 'def', label: 'Default' }],
  },
}
test('a manifest without location parses without a written default', () => {
  const declared = { ...base, capabilities: ['commands', 'panels'], contributes: { commands: [{ id: 'c', label: 'C' }], panels: [{ id: 'q', title: 'Q' }] } }
  const parsed = extensionManifestSchema.parse(declared)
  assert.deepEqual(parsed, {
    ...declared, permissions: [],
    contributes: { commands: [{ id: 'c', label: 'C' }], panels: [{ id: 'q', title: 'Q', blocks: [], actions: [] }], forms: [], chatProviders: [] },
  })
  for (const item of [...parsed.contributes.commands, ...parsed.contributes.panels]) assert.equal('location' in item, false)
  assert.equal(sdk.DEFAULT_EXTENSION_LOCATION, 'settings')
})
test('location is kept on panels and commands and validated against its own enum', () => {
  const parsed = extensionManifestSchema.parse(placed)
  assert.deepEqual(parsed.contributes.panels.map(panel => panel.location), ['sidebar', 'task', undefined])
  assert.deepEqual(parsed.contributes.commands.map(command => command.location), ['palette', 'task', undefined])
  assert.deepEqual(sdk.extensionPanelLocationSchema.options, ['settings', 'sidebar', 'task'])
  assert.deepEqual(sdk.extensionCommandLocationSchema.options, ['settings', 'palette', 'task'])
  for (const bad of [
    { contributes: { panels: [{ id: 'x', title: 'X', location: 'palette' }] } },
    { contributes: { commands: [{ id: 'x', label: 'X', location: 'sidebar' }] } },
    { contributes: { panels: [{ id: 'x', title: 'X', location: 'toolbar' }] } },
    // A panel's action BUTTON has no placement of its own.
    { contributes: { panels: [{ id: 'x', title: 'X', actions: [{ id: 'pal', label: 'P', location: 'palette' }] }] } },
  ]) assert.equal(extensionManifestSchema.safeParse({ ...base, capabilities: ['commands', 'panels'], ...bad }).success, false, JSON.stringify(bad))
})
test('per-extension placement limits: 3 sidebar panels, 5 task panels, 20 palette commands', () => {
  assert.deepEqual([sdk.MAX_SIDEBAR_PANELS, sdk.MAX_TASK_PANELS, sdk.MAX_PALETTE_COMMANDS], [3, 5, 20])
  const panels = (n, location) => Array.from({ length: n }, (_, i) => ({ id: `${location}-${i}`, title: 'P', location }))
  const commands = (n, location) => Array.from({ length: n }, (_, i) => ({ id: `${location}-${i}`, label: 'C', location }))
  const declaring = { ...base, capabilities: ['commands', 'panels'] }
  assert.equal(extensionManifestSchema.safeParse({ ...declaring, contributes: { panels: panels(3, 'sidebar') } }).success, true)
  assert.equal(extensionManifestSchema.safeParse({ ...declaring, contributes: { panels: panels(4, 'sidebar') } }).success, false)
  assert.equal(extensionManifestSchema.safeParse({ ...declaring, contributes: { panels: panels(5, 'task') } }).success, true)
  assert.equal(extensionManifestSchema.safeParse({ ...declaring, contributes: { panels: panels(6, 'task') } }).success, false)
  assert.equal(extensionManifestSchema.safeParse({ ...declaring, contributes: { commands: commands(20, 'palette') } }).success, true)
  assert.equal(extensionManifestSchema.safeParse({ ...declaring, contributes: { commands: commands(21, 'palette') } }).success, false)
  // Settings-located (default) contributions are bounded only by the array caps.
  assert.equal(extensionManifestSchema.safeParse({ ...declaring, contributes: { panels: panels(10, undefined).map(({ location, ...p }) => p) } }).success, true)
})
test('the task context shape is exported for providers and command input', () => {
  assert.deepEqual(sdk.extensionTaskContextSchema.parse({ runId: 'abc' }), { runId: 'abc' })
  assert.equal(sdk.extensionTaskContextSchema.safeParse({ runId: 'abc', projectId: 'other' }).success, false)
})
