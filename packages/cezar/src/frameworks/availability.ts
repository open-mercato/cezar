import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FrameworkFile, StageAvailability } from '@open-mercato/cezar-contract';
import { COMMAND_DIRS, discoverLocalSkills, type Skill } from '../skills.ts';

/**
 * Whether each stage's skill or slash command exists in this repo (Framework detail marks a
 * missing one red). `skills` defaults to the repo's own files (`discoverLocalSkills`, no network);
 * a caller holding the full catalog may pass it instead.
 */
export async function stageAvailability(fw: FrameworkFile, repoRoot: string, skills?: readonly Skill[]): Promise<StageAvailability[]> {
  const catalog = skills ?? (await discoverLocalSkills(repoRoot).catch(() => []));
  const names = new Set(catalog.map((s) => s.name));
  return fw.stages.map((s): StageAvailability => {
    if (s.skill) return { stage: s.id, kind: 'skill', name: s.skill, present: names.has(s.skill) };
    if (s.command) return { stage: s.id, kind: 'command', name: s.command, present: commandPresent(s.command, names, repoRoot) };
    return { stage: s.id, kind: 'none', present: true };
  });
}

/** `/openspec:apply` → a discovered command `openspec:apply`, or `<dir>/openspec/apply.md` (namespaced). */
function commandPresent(command: string, names: ReadonlySet<string>, repoRoot: string): boolean {
  const name = command.slice(1).split(/\s/)[0] ?? '';
  if (names.has(name)) return true;
  const nested = name.replace(/:/g, '/');
  return COMMAND_DIRS.some(({ dir, suffix }) => existsSync(join(repoRoot, dir, `${nested}${suffix}`)));
}

export function availabilitySummary(stages: readonly StageAvailability[]): { found: number; total: number } {
  return { found: stages.filter((s) => s.present).length, total: stages.length };
}
