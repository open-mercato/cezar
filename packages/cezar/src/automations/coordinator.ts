import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AutomationStore } from './store.js';

export interface AutomationProjectSource {
  id: string;
  root: string;
  status: 'ok' | 'missing' | 'not-git';
}

export interface AutomationCoordinatorOptions {
  listProjects: () => Promise<readonly AutomationProjectSource[]>;
  warn?: (message: string) => void;
}

/**
 * Lightweight workspace index for project automation state. Discovery checks
 * only the optional definitions file and never materializes a RunManager or a
 * full ProjectContext. Schedulers attach to these handles in Phase 4.
 */
export class AutomationCoordinator {
  private readonly stores = new Map<string, AutomationStore>();
  private readonly roots = new Map<string, string>();

  constructor(private readonly options: AutomationCoordinatorOptions) {}

  async refresh(): Promise<void> {
    let projects: readonly AutomationProjectSource[];
    try {
      projects = await this.options.listProjects();
    } catch (error) {
      this.options.warn?.(`Unable to refresh GitHub automations: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const present = new Set(projects.map((project) => project.id));
    for (const id of this.stores.keys()) {
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
    const existing = this.stores.get(projectId);
    if (existing) return existing;
    const projectRoot = root ?? this.roots.get(projectId);
    if (!projectRoot) return undefined;
    const store = AutomationStore.open(join(projectRoot, '.ai/cezar'), { warn: this.options.warn });
    this.stores.set(projectId, store);
    this.roots.set(projectId, projectRoot);
    return store;
  }

  enabledProjectIds(): string[] {
    return [...this.stores.entries()]
      .filter(([, store]) => store.list().some((definition) => definition.enabled))
      .map(([id]) => id);
  }

  remove(projectId: string): void {
    this.stores.delete(projectId);
    this.roots.delete(projectId);
  }

  ids(): string[] {
    return [...this.stores.keys()];
  }
}
