import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ExtensionRecord, ExtensionUninstallImpact } from '@open-mercato/cezar-contract'
import { loadWorkspaceConfig } from '../workspace/config.ts'
import { approved, keepsConsent } from './consent.ts'
import { extensionSecretNames } from './data.ts'
import type { ExtensionManager } from './manager.ts'
import { ExtensionStore } from './store.ts'
import { snapshotExtensionState } from './updates.ts'

const projectStore = (dataDir: string) => new ExtensionStore(join(dataDir, 'extensions', 'registry.json'))

/** Every project cezar knows (open peers and registered ones), keyed by data directory. */
async function knownProjects(manager: ExtensionManager) {
  const projects = new Map(manager.peers().map(peer => [peer.dataDir, {
    root: peer.projectRoot, id: peer.projectId, dataDir: peer.dataDir, secrets: peer.secrets,
  }]))
  for (const project of (await loadWorkspaceConfig(join(manager.home, 'config.json'))).projects ?? []) {
    const dataDir = join(project.root, '.ai/cezar')
    if (!projects.has(dataDir)) projects.set(dataDir, { root: project.root, id: project.id, dataDir, secrets: manager.secrets })
  }
  return [...projects.values()]
}

/** How many projects currently run `record` under an approval — what an update would affect. */
export async function enabledProjects(manager: ExtensionManager, record: ExtensionRecord): Promise<number> {
  let count = 0
  for (const project of await knownProjects(manager)) {
    const approvals = await projectStore(project.dataDir).list().catch(() => [])
    if (approved(approvals.find(item => item.manifest.id === record.manifest.id), record)) count++
  }
  return count
}

export async function uninstallImpact(manager: ExtensionManager, extensionId: string): Promise<ExtensionUninstallImpact> {
  const config = await loadWorkspaceConfig(join(manager.home, 'config.json'))
  const registered = config.projects ?? []
  const projects = await knownProjects(manager)
  const impact: ExtensionUninstallImpact['projects'] = []
  const approvals: { projectId: string; record: ExtensionRecord }[] = []
  for (const project of projects) {
    const records = await projectStore(project.dataDir).list()
    const record = records.find(item => item.manifest.id === extensionId)
    if (!record) continue
    approvals.push({ projectId: project.id, record })
    impact.push({
      projectId: project.id,
      name: registered.find(row => row.id === project.id)?.name || project.id,
      enabled: record.enabled,
      providers: (record.manifest.contributes?.chatProviders ?? []).map(provider => `${extensionId}/${provider.id}`),
    })
  }
  impact.sort((a, b) => a.projectId.localeCompare(b.projectId))
  const record = (await manager.catalog.list()).find(item => item.manifest.id === extensionId)
  const sorted = approvals.sort((a, b) => a.projectId.localeCompare(b.projectId))
  const revision = createHash('sha256').update(JSON.stringify({ record, projects: impact, approvals: sorted })).digest('hex')
  return { extensionId, scope: 'all-projects', revision, projects: impact, retainsConnectionData: true }
}

async function snapshotSecrets(manager: ExtensionManager, id: string): Promise<() => Promise<void>> {
  const scope = { kind: 'project' as const, projectId: manager.projectId, root: manager.projectRoot }
  const names = await extensionSecretNames(manager.dataDir, id)
  const snapshot = await manager.secrets.read(scope)
  if (names.length && snapshot.skipped) throw new Error('extension secrets are unavailable; cannot safely snapshot this update')
  return async () => {
    for (const name of await extensionSecretNames(manager.dataDir, id)) {
      const previous = names.includes(name) ? snapshot.values[name] : undefined
      if (previous) await manager.secrets.set(scope, name, previous.value, previous.audiences)
      else await manager.secrets.unset(scope, name)
    }
  }
}

export function commitPrepared(manager: ExtensionManager, preparedId: string): Promise<ExtensionRecord> {
  return manager.serialize(async () => {
    const preview = manager.takePrepared(preparedId)
    if (!preview || preview.expiresAt < Date.now()) throw new Error('extension install preview expired')
    const id = preview.value.id
    const old = (await manager.catalog.list()).find(record => record.manifest.id === id)
    const installed = await manager.installer.commitInstall(preview.value).finally(() => manager.installer.discardInstall(preview.value))
    const record: ExtensionRecord = {
      manifest: installed.manifest,
      source: installed.source,
      installedAt: new Date().toISOString(),
      integrity: installed.integrity,
      enabled: false,
    }
    const affected = await Promise.all(manager.peers().map(async peer => ({
      manager: peer,
      old: (await peer.records()).find(item => item.manifest.id === id),
      snapshot: undefined as Awaited<ReturnType<typeof snapshotExtensionState>> | undefined,
      restoreSecrets: undefined as (() => Promise<void>) | undefined,
    })))
    try {
      for (const item of affected) {
        await item.manager.stop(id)
        if (!item.old) continue
        item.restoreSecrets = await snapshotSecrets(item.manager, id)
        item.snapshot = await snapshotExtensionState(join(item.manager.dataDir, 'extensions', id))
      }
      // Publish authorization before activation can start a receive loop. The cross-process
      // mutation lock excludes peer reconciliation until activation succeeds or rollback finishes.
      await manager.catalog.update(records => [...records.filter(item => item.manifest.id !== id), record])
      for (const { manager: peer, old } of affected) await peer.approve({ ...record, enabled: keepsConsent(old, record) })
      for (const { manager: peer, old } of affected) {
        if (!keepsConsent(old, record)) continue
        peer.clearFailure(id)
        await peer.start(record)
      }
      for (const item of affected) await item.snapshot?.discard()
      await manager.installer.pruneArtifacts(id, record.integrity).catch(() => undefined)
      return (await manager.records()).find(item => item.manifest.id === id)!
    } catch (error) {
      for (const item of affected) await item.manager.stop(id)
      await manager.catalog.update(records => [
        ...records.filter(item => item.manifest.id !== id),
        ...(old ? [{ ...old, enabled: false }] : []),
      ])
      for (const item of affected) {
        await item.restoreSecrets?.()
        await item.snapshot?.restore()
        if (item.old) await item.manager.approve(item.old)
        else await item.manager.approvals.update(records => records.filter(entry => entry.manifest.id !== id))
        if (item.old?.enabled && !item.manager.closed) {
          item.manager.clearFailure(id)
          await item.manager.start(item.old)
        }
      }
      throw error
    }
  })
}

export async function uninstallExtension(manager: ExtensionManager, id: string, removeData = false, impactRevision?: string): Promise<boolean> {
  return manager.serialize(async () => {
    // Validate under the same cross-process lock as enable, update and uninstall.
    if (impactRevision !== undefined && (await uninstallImpact(manager, id)).revision !== impactRevision) {
      throw new Error('uninstall impact changed; review the affected projects again')
    }
    const found = (await manager.catalog.list()).some(item => item.manifest.id === id)
    for (const peer of manager.peers()) await peer.stop(id)
    await manager.catalog.update(records => records.filter(item => item.manifest.id !== id))
    await manager.installer.pruneArtifacts(id).catch(() => undefined)
    const projects = await knownProjects(manager)
    // Revoke approval everywhere; reinstall never resumes code. Keep-data retains the row as Missing for a reinstall.
    for (const project of projects) {
      await projectStore(project.dataDir)
        .update(records => records.map(item => item.manifest.id === id ? { ...item, enabled: false } : item))
        .catch(() => undefined)
    }
    if (removeData) {
      for (const project of projects) {
        const scope = { kind: 'project' as const, projectId: project.id, root: project.root }
        for (const name of await extensionSecretNames(project.dataDir, id)) await project.secrets.unset(scope, name)
        await rm(join(project.dataDir, 'extensions', id), { recursive: true, force: true })
        // Last, so a crash leaves the old Missing row.
        await projectStore(project.dataDir)
          .update(records => records.filter(item => item.manifest.id !== id))
          .catch(() => undefined)
      }
    }
    return found
  })
}
