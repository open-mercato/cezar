import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { extensionLogger } from './logger.ts'
import { ExtensionManager } from './manager.ts'
import { ExtensionTaskEventBus } from './events.ts'
import { extensionsFlagOff } from '../server/capabilities.ts'
import type { ExtensionContextDeps } from './context.ts'

// Every owner names its real mode and runtime gate: the first one created is shared (spec 2026-11-12 §1).
type Project = { root: string; dataDir: string; projectId: string; mode: 'local' | 'hosted'; runtimeAllowed: boolean }
type Binding = Pick<ExtensionContextDeps, 'listTasks' | 'getTask' | 'log'>
type Entry = {
  manager: ExtensionManager
  events: ExtensionTaskEventBus
  dataDir: string
  bindings: Map<symbol, Binding>
  owners: Set<symbol>
  closing?: Promise<void>
}
const projects = new Map<string, Entry>()

/** Opens the webhook owner for the manager (injected as `openChatOwner`). Imported lazily because
 *  webhooks/service.ts imports this module: the cycle is deferred to call time, not absent. */
export function chatManagementOwner(project: Project) {
  return async () => {
    const [{ WebhookService }, { WebhookScheduler }] = await Promise.all([import('../webhooks/service.ts'), import('../webhooks/scheduler.ts')])
    return WebhookService.open({
      root: project.root, dataDir: project.dataDir, projectId: project.projectId, mode: project.mode, runtimeAllowed: project.runtimeAllowed,
      serverPorts: () => [], scheduler: new WebhookScheduler(), chatManagementOnly: true,
    })
  }
}

/** Boot chat and HTTP extensions share one owner. The last release drains it;
 * a new owner waits for that drain before it can publish replacement providers. */
export async function retainProjectExtensions(project: Project, binding: Binding = {}) {
  const root = await realpath(project.root)
  // Resolve a project-relative data path against the canonical root, including
  // before that directory exists. Distinct or external data paths stay distinct.
  const suffix = relative(resolve(project.root), resolve(project.dataDir))
  const dataDir = !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep)
    ? resolve(root, suffix) : resolve(project.dataDir)
  let entry = projects.get(root)
  while (entry?.closing) {
    await entry.closing
    entry = projects.get(root)
  }
  if (entry && entry.dataDir !== dataDir) throw Error('Project extension data directory does not match its active owner')
  if (!entry) {
    const bindings = new Map<symbol, Binding>()
    const events = new ExtensionTaskEventBus()
    const log = extensionLogger(project.projectId)
    const current = () => [...bindings.values()].at(-1)
    const manager = new ExtensionManager(dataDir, project.projectId, root, {
      events,
      chatOnDemand: true,
      executionPolicy: () => extensionsFlagOff(process.env) ? 'facade' : 'worker',
      openChatOwner: chatManagementOwner({ root, dataDir, projectId: project.projectId, mode: project.mode, runtimeAllowed: project.runtimeAllowed }),
      listTasks: async () => await current()?.listTasks?.() ?? [],
      getTask: async id => current()?.getTask?.(id),
      log: (level, message, id) => (current()?.log ?? log)(level, message, id),
    })
    entry = { manager, events, dataDir, bindings, owners: new Set() }
    projects.set(root, entry)
  }
  const owned = entry
  const token = Symbol()
  owned.owners.add(token)
  if (Object.keys(binding).length) owned.bindings.set(token, binding)
  let released = false
  return {
    manager: owned.manager,
    events: owned.events,
    async release() {
      if (released) return owned.closing
      released = true
      owned.owners.delete(token)
      owned.bindings.delete(token)
      if (owned.owners.size) return
      owned.closing = owned.manager.close().then(() => {
        if (projects.get(root) === owned) projects.delete(root)
      })
      await owned.closing
    },
  }
}
