import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ScheduledTaskStore } from './store.ts';

export interface ScheduledTaskProjectSource {
  id: string;
  root: string;
  status: 'ok' | 'missing' | 'not-git';
}

export interface ScheduledTaskCoordinatorOptions {
  listProjects: () => Promise<readonly ScheduledTaskProjectSource[]>;
  warn?: (message: string) => void;
}

/**
 * Lightweight workspace index for project scheduled-task state (spec 2026-08-01-postponed-tasks).
 * Discovery only touches the optional definitions file and never materializes a RunManager or a
 * full ProjectContext — the same demand-independent shape as `../automations/coordinator.ts`.
 */
export class ScheduledTaskCoordinator {
  private readonly stores = new Map<string, ScheduledTaskStore>();
  private readonly roots = new Map<string, string>();

  constructor(private readonly options: ScheduledTaskCoordinatorOptions) {}

  async refresh(): Promise<void> {
    let projects: readonly ScheduledTaskProjectSource[];
    try {
      projects = await this.options.listProjects();
    } catch (error) {
      this.options.warn?.(
        `Unable to refresh scheduled tasks: ${error instanceof Error ? error.message : String(error)}`,
      );
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
      const definitions = join(project.root, '.ai/cezar/scheduled-tasks.json');
      if (existsSync(definitions)) this.store(project.id, project.root);
    }
  }

  store(projectId: string, root?: string): ScheduledTaskStore | undefined {
    const existing = this.stores.get(projectId);
    if (existing) return existing;
    const projectRoot = root ?? this.roots.get(projectId);
    if (!projectRoot) return undefined;
    const store = ScheduledTaskStore.open(join(projectRoot, '.ai/cezar'), { warn: this.options.warn });
    this.stores.set(projectId, store);
    this.roots.set(projectId, projectRoot);
    return store;
  }

  /** Projects with at least one enabled definition — the only ones the timer needs to consider. */
  enabledProjectIds(): string[] {
    return [...this.stores.entries()]
      .filter(([, store]) => store.list().some((definition) => definition.enabled))
      .map(([id]) => id);
  }

  root(projectId: string): string | undefined {
    return this.roots.get(projectId);
  }

  remove(projectId: string): void {
    this.stores.delete(projectId);
    this.roots.delete(projectId);
  }

  ids(): string[] {
    return [...this.stores.keys()];
  }
}
