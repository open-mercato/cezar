// Drives the built extension through a fake host context, the way cezar's worker does.
// Run with `npm test` here, or from the SDK's pack-smoke against the packed SDK.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { extensionManifestSchema } from '@open-mercato/cezar-extension-sdk/schemas'
import extension from '../dist/index.js'

const manifest = extensionManifestSchema.parse(JSON.parse(readFileSync(new URL('../cezar-extension.json', import.meta.url), 'utf8')))

function host(initial) {
  const commands = new Map(), panels = new Map(), listeners = new Set(), proposals = []
  const register = map => (id, handler) => { map.set(id, handler); return { async dispose() { map.delete(id) } } }
  const state = { tasks: initial }
  const context = {
    projectId: 'external', permissions: manifest.permissions,
    tasks: {
      list: async () => state.tasks,
      get: async runId => state.tasks.find(task => task.id === runId) ?? null,
      propose: async input => { proposals.push(input); return { proposalId: String(proposals.length), accepted: false } },
    },
    commands: { register: register(commands) }, panels: { register: register(panels) },
    taskEvents: { subscribe(handler) { listeners.add(handler); return { async dispose() { listeners.delete(handler) } } } },
  }
  return { context, commands, panels, listeners, proposals, state }
}
const tasks = [
  { id: 'r1', title: 'First', status: 'running' },
  { id: 'r2', title: 'Second', status: 'waiting' },
  { id: 'r3', title: 'Third', status: 'done' },
  { id: 'r4', title: 'Fourth', status: 'review' },
]

test('the manifest places every contribution: Settings panel, sidebar panel, task panel, palette and task commands', () => {
  assert.equal(manifest.entry, 'dist/index.js')
  assert.deepEqual(manifest.permissions, ['project.read', 'task.create'])
  assert.deepEqual(manifest.contributes.panels.map(panel => [panel.id, panel.location]), [['summary', undefined], ['counts', 'sidebar'], ['task', 'task']])
  assert.deepEqual(manifest.contributes.commands.map(command => [command.id, command.location]), [['refresh', 'palette'], ['follow-up', 'task']])
})

test('activation registers exactly the declared ids and disposal releases them all', async () => {
  const { context, commands, panels, listeners } = host(tasks)
  const cleanup = await extension.activate(context)
  assert.deepEqual([...panels.keys()].sort(), manifest.contributes.panels.map(panel => panel.id).sort())
  assert.deepEqual([...commands.keys()].sort(), manifest.contributes.commands.map(command => command.id).sort())
  assert.equal(listeners.size, 1)
  await cleanup.dispose()
  assert.equal(commands.size + panels.size + listeners.size, 0)
})

test('the Settings panel keeps its V1 table and Refresh action, and the refresh command reloads it', async () => {
  const { context, commands, panels, state } = host(tasks)
  const cleanup = await extension.activate(context)
  const panel = await panels.get('summary')()
  assert.equal(panel.blocks[0].type, 'table')
  assert.equal(panel.blocks[0].rows[0][0], 'First')
  assert.deepEqual(panel.actions, [{ id: 'refresh', label: 'Refresh summary' }])
  state.tasks = [{ id: 'r9', title: 'Later', status: 'done' }]
  assert.deepEqual(await commands.get('refresh')(undefined, context), { message: 'Summary refreshed' })
  assert.equal((await panels.get('summary')()).blocks[0].rows[0][0], 'Later')
  await cleanup.dispose()
})

test('the sidebar panel counts open, running and waiting tasks and needs no task context', async () => {
  const { context, panels } = host(tasks)
  const cleanup = await extension.activate(context)
  const panel = await panels.get('counts')()
  assert.deepEqual(panel.blocks.map(block => [block.label, block.value]), [['Open', '3'], ['Running', '1'], ['Waiting', '1']])
  await cleanup.dispose()
})

test('the task panel reads the host-asserted run through tasks.get and degrades without one', async () => {
  const { context, panels } = host(tasks)
  const cleanup = await extension.activate(context)
  const panel = await panels.get('task')({ runId: 'r2' })
  assert.deepEqual(panel.blocks.map(block => [block.label, block.value]), [['Title', 'Second'], ['Status', 'waiting'], ['Lifecycle', 'started']])
  assert.equal((await panels.get('task')({ runId: 'r3' })).blocks[2].value, 'finished')
  assert.equal((await panels.get('task')()).blocks[0].type, 'text')
  assert.equal((await panels.get('task')({ runId: 'missing' })).blocks[0].type, 'text')
  await cleanup.dispose()
})

test('the task command proposes a follow-up titled after the run, and only when run from a task', async () => {
  const { context, commands, proposals } = host(tasks)
  const cleanup = await extension.activate(context)
  assert.deepEqual(await commands.get('follow-up')({ runId: 'r1' }, context), { message: 'Proposed a follow-up to "First"' })
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0].title, 'Follow-up: First')
  assert.match(proposals[0].prompt, /run r1, status running/)
  assert.deepEqual(await commands.get('follow-up')(undefined, context), { message: 'Run Propose follow-up from a task.' })
  assert.equal(proposals.length, 1)
  await cleanup.dispose()
})

test('task events refresh the snapshot every panel reads', async () => {
  const { context, panels, listeners, state } = host(tasks)
  const cleanup = await extension.activate(context)
  state.tasks = []
  for (const listener of listeners) await listener({ type: 'resyncRequired' })
  assert.equal((await panels.get('counts')()).blocks[0].value, '0')
  await cleanup.dispose()
})
