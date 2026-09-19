import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AutomationTemplate } from '@open-mercato/cezar-contract';
import { AutomationStore } from './store.ts';

/**
 * The editor's "From your other projects" palette (spec 2026-09-14-automations-redesign Q7):
 * every OTHER registered project's automation definitions, read as templates. Read-only, from
 * each project's own `.ai/cezar/automations.json`; a project whose root is gone, has no
 * definitions file, or whose file cannot be read is simply absent from the answer — a broken
 * neighbour must never take the palette down.
 */
export function automationTemplatesOf(
  projects: ReadonlyArray<{ id: string; root: string; name?: string; status?: string }>,
  exclude?: string,
): AutomationTemplate[] {
  const templates: AutomationTemplate[] = [];
  for (const project of projects) {
    if (project.id === exclude || project.status === 'missing') continue;
    const dataDir = join(project.root, '.ai/cezar');
    if (!existsSync(join(dataDir, 'automations.json'))) continue;
    let definitions;
    try {
      definitions = AutomationStore.open(dataDir, { warn: () => undefined }).list();
    } catch {
      continue;
    }
    for (const definition of definitions) {
      templates.push({
        project: { id: project.id, name: project.name || basename(project.root) },
        id: definition.id,
        name: definition.name,
        kind: definition.kind,
        ...(definition.schedule ? { schedule: definition.schedule } : {}),
        ...(definition.events ? { events: definition.events } : {}),
        ...(definition.intervalSeconds !== undefined ? { intervalSeconds: definition.intervalSeconds } : {}),
        task: {
          prompt: definition.task.prompt,
          ...(definition.task.workflow ? { workflow: definition.task.workflow } : {}),
          ...(definition.task.runner ? { runner: definition.task.runner } : {}),
          ...(definition.task.model ? { model: definition.task.model } : {}),
          ...(definition.task.autonomous !== undefined ? { autonomous: definition.task.autonomous } : {}),
          ...(definition.task.dispatch ? { dispatch: definition.task.dispatch } : {}),
        },
      });
    }
  }
  return templates;
}
