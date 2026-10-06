import type { Skill } from './skills.ts';

/** Most skills the catalog lists; the rest are dropped (alphabetical-by-discovery order is kept). */
export const SKILL_CATALOG_MAX = 40;
/** Longest description kept per skill — the catalog is a menu, not the skill. */
export const SKILL_CATALOG_DESCRIPTION_MAX = 160;

/**
 * Default-on; `CEZ_SKILL_CATALOG=0` turns it off. The catalog costs a few hundred tokens per
 * session (bounded by the two caps above) and touches no network.
 */
export function skillCatalogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_SKILL_CATALOG !== '0';
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The skill catalog part of a run's system prompt: name, description and absolute path for each
 * skill the agent can read from disk, so it can choose a relevant one itself instead of waiting for
 * an explicit `/skill`. Returns `undefined` when there is nothing to offer.
 *
 * Only skills with a real file path are listed — `builtin` skills are virtual and `team` skills are
 * only materialized into the worktree when selected, so the agent could not open either. The skill
 * already selected for the step (`selected`) is omitted: its body is already in the prompt.
 */
export function skillCatalogPart(
  skills: readonly Skill[] | undefined,
  selected?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!skillCatalogEnabled(env)) return undefined;
  const listed = (skills ?? [])
    .filter((s) => s.source !== 'builtin' && s.source !== 'team' && s.name !== selected && s.path)
    .slice(0, SKILL_CATALOG_MAX);
  if (!listed.length) return undefined;
  const lines = listed.map((s) => {
    const desc = s.description ? ` — ${oneLine(s.description, SKILL_CATALOG_DESCRIPTION_MAX)}` : '';
    return `- ${s.name}${desc} (${s.path})`;
  });
  return [
    '## Available skills',
    'These skills are installed for this project. When one clearly fits the task, read its file with the Read tool and follow it; when none fits, ignore this list. Do not mention the list to the user unless asked.',
    '',
    ...lines,
  ].join('\n');
}
