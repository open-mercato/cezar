import {extensionLogger} from '../extensions/logger.ts'
import { retainProjectExtensions } from '../extensions/project-runtime.ts'
import type { RunRecord } from '../runs/store.ts'
import { Hono, type Context, type Next } from 'hono'
import {
  extensionActionResponseSchema,
  extensionChatSelectionParamsSchema, extensionChatSelectionInputSchema, extensionChatSelectionPreviewSchema, extensionChatSelectionCommitSchema,
  extensionInventoryResponseSchema,
  extensionUninstallImpactSchema,
  extensionCommandParamsSchema,
  extensionCommitInstallInputSchema,
  extensionEnableInputSchema,
  extensionFormsResponseSchema,
  extensionIdParamsSchema,
  extensionInvokeInputSchema,
  extensionMutationResponseSchema,
  extensionPanelParamsSchema,
  extensionPanelQuerySchema,
  extensionPanelSchema,
  extensionPlacementsQuerySchema,
  extensionPlacementsResponseSchema,
  extensionPrepareInstallInputSchema,
  extensionPrepareInstallResponseSchema,
  extensionRecordSchema,
  extensionUninstallQuerySchema,
  extensionsResponseSchema,
} from '@open-mercato/cezar-contract'
import { queryZodValidator, jsonZodValidator, paramZodValidator } from './validators.ts'
import { ExtensionManager, ExtensionRunNotFoundError } from '../extensions/manager.ts'
import { extensionsFlagOff, extensionsOffReason } from './capabilities.ts'
import type { ProjectContext } from './project-context.ts'

type Env = { Variables: { project: ProjectContext; shippedOnly: boolean } }
const managers = new WeakMap<ProjectContext, Promise<ExtensionManager>>()
const cleanups = new WeakMap<ProjectContext, () => Promise<void>>()
function manager(project: ProjectContext): Promise<ExtensionManager> {
  let value = managers.get(project)
  if (!value) {
    value = (async()=>{
      const summary = (run: RunRecord) => ({ id: run.id, title: run.title, status: run.status })
      const owner = await retainProjectExtensions({root:project.root,dataDir:project.dataDir,projectId:project.id},{
        listTasks:async()=>project.store.listRuns().map(summary),
        getTask:async id=>{const run=project.store.getRun(id);return run?summary(run):undefined},
        log:extensionLogger(project.id),
      })
      const onRun=(run:RunRecord)=>owner.events.publish({type:'updated',task:summary(run)})
      project.store.on('run',onRun)
      cleanups.set(project,async()=>{project.store.off('run',onRun);await owner.release()})
      return owner.manager
    })()
    managers.set(project,value)
    void value.catch(()=>{if(managers.get(project)===value)managers.delete(project)})
  }
  return value
}

/** Why extension code may not run here, or undefined when it may. */
export type ExtensionsUnavailable = () => string | undefined
const always: ExtensionsUnavailable = () => undefined

/** Installing or running extension code is a local-machine capability, like agent-config writes
 *  (hosted cockpits refuse it), and `CEZ_EXTENSIONS=0` turns it off everywhere. */
export function extensionsUnavailableReason(env: NodeJS.ProcessEnv, localHandoff: boolean): string | undefined {
  const off = extensionsOffReason(env, localHandoff)
  if (off === 'flag_off') return 'extensions are turned off on this cockpit (CEZ_EXTENSIONS=0)'
  if (off === 'hosted') return 'extensions are disabled in hosted mode; install and run them on the machine hosting cezar'
  return undefined
}

export async function restoreProjectExtensions(project: ProjectContext, unavailable: ExtensionsUnavailable = always): Promise<void> {
  if (!unavailable()) await (await manager(project)).restore({chatOnDemand:true})
}

function requireLocal(unavailable: ExtensionsUnavailable) {
  return async (c: Context, next: Next) => {
    const reason = unavailable()
    if (reason) return c.json({ error: reason }, 409)
    await next()
  }
}

export async function closeProjectExtensions(project: ProjectContext): Promise<void> {
  const value=managers.get(project)
  await value?.catch(()=>undefined)
  if(managers.get(project)!==value)return
  managers.delete(project)
  const release=cleanups.get(project)
  cleanups.delete(project)
  await release?.()
}

/** Project-scoped extension API. Actions are always declared in the manifest and run in the
 * extension's long-lived per-project worker process, behind a narrow, immutable host context. */
export function extensionRoutes(unavailable: ExtensionsUnavailable = always, discloseInventory: () => boolean = () => true) {
  const local = requireLocal(unavailable)
  const flagOff = () => extensionsFlagOff(process.env)
  const chatManagement = async (c: Context<Env>, next: Next) => {
    if (!discloseInventory()) return c.json({error:'extensions are disabled in hosted mode'},409)
    const reason = unavailable()
    if (reason && !(flagOff() && await (await manager(c.get('project'))).canManageDelivered(c.req.param('extensionId') ?? ''))) return c.json({error:reason},409)
    c.set('shippedOnly', Boolean(reason))
    await next()
  }
  return new Hono<Env>()
    // Access discovery must not instantiate or start extension workers when the local
    // capability is unavailable. The cockpit can still render an empty, honest surface.
    .get('/extensions/inventory', async c => {
      if (!discloseInventory()) return c.json(extensionInventoryResponseSchema.parse({extensions:[]}))
      const reason = unavailable()
      return c.json(extensionInventoryResponseSchema.parse({extensions:await (await manager(c.get('project'))).inventory(reason ? flagOff() ? 'flag-disabled' : 'hosted' : undefined)}))
    })
    .post('/extensions/chat-selections/:provider/preview', paramZodValidator(extensionChatSelectionParamsSchema), jsonZodValidator(extensionChatSelectionInputSchema), async c=>{
      const input=c.req.valid('json'),reason=unavailable()
      if(!discloseInventory() || (reason && !(flagOff()&&input.target.kind==='shipped')))return c.json({error:reason??'extensions are disabled in hosted mode'},409)
      try{return c.json(extensionChatSelectionPreviewSchema.parse(await (await manager(c.get('project'))).previewChatSelection(c.req.valid('param').provider,input)),200)}
      catch(error){return c.json({error:error instanceof Error?error.message:'chat selection could not be inspected'},400)}
    })
    .post('/extensions/chat-selections/:provider/select', paramZodValidator(extensionChatSelectionParamsSchema), jsonZodValidator(extensionChatSelectionCommitSchema), async c=>{
      const input=c.req.valid('json'),reason=unavailable()
      if(!discloseInventory() || (reason && !(flagOff()&&input.target.kind==='shipped')))return c.json({error:reason??'extensions are disabled in hosted mode'},409)
      try{return c.json(extensionChatSelectionPreviewSchema.parse(await (await manager(c.get('project'))).selectChat(c.req.valid('param').provider,input,()=>!discloseInventory()?'blocked':unavailable()?flagOff()?'facade':'blocked':'worker')),200)}
      catch(error){return c.json({error:error instanceof Error?error.message:'chat selection could not be changed'},(!discloseInventory()||(unavailable()&&!(flagOff()&&input.target.kind==='shipped')))?409:400)}
    })
    .get('/extensions/access', async c => {
      if (unavailable()) return c.json(extensionsResponseSchema.parse({ extensions: [] }))
      return c.json(extensionsResponseSchema.parse({ extensions: await (await manager(c.get('project'))).list() }))
    })
    // A read, so unavailability is data (`available: false`), not a 409: the surfaces hide themselves.
    .get('/extensions/placements', queryZodValidator(extensionPlacementsQuerySchema), async c => {
      if (unavailable()) return c.json(extensionPlacementsResponseSchema.parse({ available: false, extensions: [] }))
      const extensions = await (await manager(c.get('project'))).placements(c.req.valid('query').location)
      return c.json(extensionPlacementsResponseSchema.parse({ available: true, extensions }))
    })
    .post('/extensions/:extensionId/enable', paramZodValidator(extensionIdParamsSchema), chatManagement, jsonZodValidator(extensionEnableInputSchema), async c => {
      try {
        const record = await (await manager(c.get('project'))).setEnabled(c.req.valid('param').extensionId, true, c.req.valid('json').integrity, {shippedOnly:c.get('shippedOnly')})
        return record ? c.json(extensionRecordSchema.parse(record)) : c.json({ error: 'extension not found' }, 404)
      } catch (error) { return c.json({ error: error instanceof Error ? error.message : 'extension could not be enabled' }, 400) }
    })
    .post('/extensions/:extensionId/disable', paramZodValidator(extensionIdParamsSchema), chatManagement, async c => {
      try {
        const record = await (await manager(c.get('project'))).setEnabled(c.req.valid('param').extensionId, false, undefined, {shippedOnly:c.get('shippedOnly')})
        return record ? c.json(extensionRecordSchema.parse(record)) : c.json({ error: 'extension not found' }, 404)
      } catch (error) { return c.json({error:error instanceof Error ? error.message : 'extension could not be disabled'},400) }
    })
    // A failed worker or a bad reply is an expected state here, not a server fault.
    .get('/extensions/:extensionId/forms', local, paramZodValidator(extensionIdParamsSchema), async c => {
      try { return c.json(extensionFormsResponseSchema.parse({ forms: await (await manager(c.get('project'))).forms(c.req.valid('param').extensionId) }), 200) }
      catch (error) { return c.json({ error: error instanceof Error ? error.message : 'extension forms could not be loaded' }, 400) }
    })
    // `runId` names the task a `task`-located panel is rendered for; it is resolved in this
    // project's store, and an unknown one is a 404 before any worker is called.
    .get('/extensions/:extensionId/panels/:panelId', local, paramZodValidator(extensionPanelParamsSchema), queryZodValidator(extensionPanelQuerySchema), async c => {
      const { extensionId, panelId } = c.req.valid('param')
      const { runId } = c.req.valid('query')
      try {
        const extensions = await manager(c.get('project'))
        const enabled = (await extensions.list()).some(item => item.manifest.id === extensionId && item.enabled)
        const panel = enabled ? await extensions.panel(extensionId, panelId, { ...(runId ? { runId } : {}) }) : undefined
        return panel ? c.json(extensionPanelSchema.parse(panel), 200) : c.json({ error: 'extension panel not found' }, 404)
      } catch (error) {
        if (error instanceof ExtensionRunNotFoundError) return c.json({ error: error.message }, 404)
        return c.json({ error: error instanceof Error ? error.message : 'extension panel could not be loaded' }, 400)
      }
    })
    .post('/extensions/:extensionId/commands/:commandId/invoke', local, paramZodValidator(extensionCommandParamsSchema), jsonZodValidator(extensionInvokeInputSchema), async c => {
      const { extensionId, commandId } = c.req.valid('param')
      const { input, runId } = c.req.valid('json')
      // Explicit 200: without a status hono folds this body into every status the route can answer.
      try { return c.json(extensionActionResponseSchema.parse(await (await manager(c.get('project'))).invoke(extensionId, commandId, input, { ...(runId ? { runId } : {}) })), 200) }
      catch (error) {
        if (error instanceof ExtensionRunNotFoundError) return c.json({ error: error.message }, 404)
        return c.json({ error: error instanceof Error ? error.message : 'extension command failed' }, 400)
      }
    })

}

/** Software installation is global; access, commands and data remain project-scoped. */
export function globalExtensionRoutes(project: ProjectContext, unavailable: ExtensionsUnavailable = always, discloseInventory: () => boolean = () => true) {
  const local = requireLocal(unavailable)
  return new Hono()
    // Names every registered project, so a hosted cockpit keeps it hidden like the inventory.
    .get('/extensions/:extensionId/uninstall-impact', paramZodValidator(extensionIdParamsSchema), async c => {
      if (!discloseInventory()) return c.json({ error: 'extensions are disabled in hosted mode' }, 409)
      return c.json(extensionUninstallImpactSchema.parse(await (await manager(project)).uninstallImpact(c.req.valid('param').extensionId)), 200)
    })
    .get('/extensions', async c => c.json(extensionsResponseSchema.parse({ extensions: await (await manager(project)).installed() })))
    .post('/extensions/:extensionId/prepare-update', local, paramZodValidator(extensionIdParamsSchema), async c => {
      try { return c.json(extensionPrepareInstallResponseSchema.parse(await (await manager(project)).prepareUpdate(c.req.valid('param').extensionId))) }
      catch (error) { return c.json({ error: error instanceof Error ? error.message : 'extension could not be inspected' }, 400) }
    })
    .post('/extensions/prepare-install', local, jsonZodValidator(extensionPrepareInstallInputSchema), async c => {
      try { return c.json(extensionPrepareInstallResponseSchema.parse(await (await manager(project)).prepare(c.req.valid('json').source))) }
      catch (error) { return c.json({ error: error instanceof Error ? error.message : 'extension could not be inspected' }, 400) }
    })
    .post('/extensions/commit-install', local, jsonZodValidator(extensionCommitInstallInputSchema), async c => {
      try { return c.json(extensionRecordSchema.parse(await (await manager(project)).commit(c.req.valid('json').preparedId)), 201) }
      catch (error) { return c.json({ error: error instanceof Error ? error.message : 'extension could not be installed' }, 400) }
    })
    .delete('/extensions/:extensionId', local, paramZodValidator(extensionIdParamsSchema), queryZodValidator(extensionUninstallQuerySchema), async c => {
      try {
        const query = c.req.valid('query')
        const removed = await (await manager(project)).uninstall(c.req.valid('param').extensionId, query.removeData === 'true', query.impactRevision)
        return removed ? c.json(extensionMutationResponseSchema.parse({ ok: true })) : c.json({ error: 'extension not found' }, 404)
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'extension could not be uninstalled' }, 409)
      }
    })
}

export const subscribeExtensionChanges = (listener: () => void) => ExtensionManager.subscribe(listener)
