import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AutomationStore } from './store.ts';

/**
 * The identity of a project's automation state is its DIRECTORY, not the id the
 * caller happens to address it by. One folder can legitimately carry two ids at
 * once: the boot alias (`'default'`) the server opens it under, and the registry
 * slug it acquires the moment the user saves the served folder. Realpath'd so a
 * symlinked spelling and the registry's normalized root agree — `registerProject`
 * stores realpaths, while the boot root is whatever the process was started with.
 */
function rootKey(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    // Missing or unreadable folder: fall back to the lexical path rather than
    // throwing. A store over a directory that is not there degrades on its own.
    return resolve(root);
  }
}

export interface AutomationProjectSource {
  id: string;
  root: string;
  status: 'ok' | 'missing' | 'not-git';
}

export interface AutomationCoordinatorOptions {
  listProjects: () => Promise<readonly AutomationProjectSource[]>;
  warn?: (message: string) => void;
  /**
   * The boot project's id, which `refresh()` must never evict even though
   * `listProjects()` (the REGISTRY) does not name it. The server serves the
   * folder it was started in whether or not that folder is registered, and
   * since boot registration became seed-once (`shouldAutoRegisterProject`)
   * the unregistered case is the ordinary one — the store is then keyed on
   * the `'default'` boot alias, which is never a registry id. Without this
   * the sweep below drops that store on the first `reschedule()`, and the
   * boot project's automations stay visible and editable in the cockpit
   * while nothing ever polls for them.
   */
  pinned?: string;
}

/**
 * Lightweight workspace index for project automation state. Discovery checks
 * only the optional definitions file and never materializes a RunManager or a
 * full ProjectContext. Schedulers attach to these handles in Phase 4.
 */
export class AutomationCoordinator {
  /**
   * ROOT → store, one instance per directory. `AutomationStore` is file-backed
   * with an in-memory snapshot taken at `open()` — `list()` serves that snapshot
   * and `setState()` rewrites the whole state file from the writer's own copy —
   * so two instances over one `.ai/cezar` diverge permanently the first time
   * either writes. Keying by id let that happen as soon as one folder had two
   * ids: the cockpit wrote through the boot alias while the scheduler polled a
   * second store, so a disabled automation kept firing and cursors rolled back.
   */
  private readonly stores = new Map<string, AutomationStore>();
  /** projectId → the root that id addresses (unnormalized; `rootKey` normalizes). */
  private readonly roots = new Map<string, string>();
  /** The project ids that have actually been opened, as `ids()` has always meant. */
  private readonly opened = new Set<string>();

  constructor(private readonly options: AutomationCoordinatorOptions) {}

  async refresh(): Promise<void> {
    let projects: readonly AutomationProjectSource[];
    try {
      projects = await this.options.listProjects();
    } catch (error) {
      this.options.warn?.(`Unable to refresh GitHub automations: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    // The pinned boot id survives the sweep: it is a project this process is
    // demonstrably serving, not a stale handle, and the registry it is being
    // compared against is exactly the list that does not know about it.
    const present = new Set(projects.map((project) => project.id));
    if (this.options.pinned !== undefined) present.add(this.options.pinned);
    for (const id of [...this.opened]) {
      if (!present.has(id)) this.remove(id);
    }
    for (const project of projects) {
      if (project.status === 'missing') {
        this.remove(project.id);
        continue;
      }
      this.roots.set(project.id, project.root);
      const definitions = join(project.root, '.ai/cezar/automations.json');
      if (existsSync(definitions)) this.store(project.id, project.root);
    }
  }

  store(projectId: string, root?: string): AutomationStore | undefined {
    const projectRoot = root ?? this.roots.get(projectId);
    if (!projectRoot) return undefined;
    this.roots.set(projectId, projectRoot);
    this.opened.add(projectId);
    const key = rootKey(projectRoot);
    let store = this.stores.get(key);
    if (!store) {
      store = AutomationStore.open(join(projectRoot, '.ai/cezar'), { warn: this.options.warn });
      this.stores.set(key, store);
    }
    return store;
  }

  /**
   * One id per DIRECTORY, so a folder addressed twice is scheduled once — the
   * scheduler builds a due entry per id returned here, and two ids for one root
   * meant every definition in it polled and launched twice.
   *
   * The pinned boot id wins that tie deliberately. `/p/<slug>/` resolves to the
   * boot context anyway, but the scheduler's `launch` only takes the boot
   * manager and store when it is handed the boot id; given the slug it would
   * build a SECOND `ProjectContext` over the boot root, double-opening the
   * `.ai/cezar` state the server takes care never to open twice.
   */
  enabledProjectIds(): string[] {
    const chosen = new Map<string, string>();
    for (const projectId of this.opened) {
      const root = this.roots.get(projectId);
      if (root === undefined) continue;
      const key = rootKey(root);
      const store = this.stores.get(key);
      if (!store?.list().some((definition) => definition.enabled)) continue;
      if (!chosen.has(key) || projectId === this.options.pinned) chosen.set(key, projectId);
    }
    return [...chosen.values()];
  }

  remove(projectId: string): void {
    const root = this.roots.get(projectId);
    this.roots.delete(projectId);
    this.opened.delete(projectId);
    if (root === undefined) return;
    // The store outlives this id when another one still addresses the same
    // folder — dropping it would hand the survivor a fresh snapshot and
    // reintroduce exactly the divergence one-store-per-root exists to prevent.
    const key = rootKey(root);
    for (const other of this.opened) {
      const otherRoot = this.roots.get(other);
      if (otherRoot !== undefined && rootKey(otherRoot) === key) return;
    }
    this.stores.delete(key);
  }

  ids(): string[] {
    return [...this.opened];
  }
}
