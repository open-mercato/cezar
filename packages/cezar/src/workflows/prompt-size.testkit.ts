/**
 * Helpers for `prompt-size.test.ts` (#1225). Everything here is synthetic: made-up skills and
 * task text, never derived from a real repo, transcript or installed skill set.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SKILL_COUNT = 36;
export const SELECTED_SKILL = 'synthetic-skill-07';

const SENTENCES = [
  'Read the files named in the task before changing anything.',
  'Keep each change small and explain the reason in one line.',
  'Run the repository checks after every edit and report their output.',
  'Never touch generated files or lockfiles unless the task says so.',
  'When a requirement is ambiguous, state the assumption and continue.',
  'Prefer the existing helper over writing a new one.',
];

/** The body of a synthetic skill: fixed length per index, realistic prose, no real content. */
export function skillBody(index: number): string {
  const lines: string[] = [`# Synthetic skill ${index}`, ''];
  for (let i = 0; i < 14; i++) lines.push(`${i + 1}. ${SENTENCES[(index + i) % SENTENCES.length]}`);
  return lines.join('\n');
}

export function skillName(index: number): string {
  return `synthetic-skill-${String(index).padStart(2, '0')}`;
}

/** Write `SKILL_COUNT` skills under `<repo>/.ai/skills/`. */
export function writeSyntheticSkills(repoRoot: string): void {
  for (let i = 1; i <= SKILL_COUNT; i++) {
    const dir = join(repoRoot, '.ai/skills', skillName(i));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${skillName(i)}\ndescription: Synthetic skill number ${i} used only to size prompts.\n---\n${skillBody(i)}\n`,
      'utf8',
    );
  }
}

/** One JSON object per line of a capture file, or [] when the hook never fired. */
export function readJsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

export interface TurnSize {
  backend: string;
  turn: string;
  /** Characters of the composed system prompt delivered with this turn (0 when not re-sent). */
  system: number;
  /** Of `system`: the selected skill body (a breakdown — never added to the total twice). */
  skill: number;
  /** Characters of user text. */
  user: number;
  /** Prompt text delivered for this turn: system + user + any separator. */
  total: number;
  /** `unsupported` rows carry no sizes. */
  note?: string;
}

/** The size table, with characters/4 as an ESTIMATED token count. */
export function formatTable(rows: TurnSize[]): string {
  const head = ['backend', 'turn', 'system', 'skill', 'user', 'total', '~tokens'];
  const body = rows.map((r) =>
    r.note
      ? [r.backend, r.turn, '-', '-', '-', '-', r.note]
      : [r.backend, r.turn, r.system, r.skill, r.user, r.total, Math.ceil(r.total / 4)].map(String),
  );
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  return [line(head), ...body.map(line)].join('\n');
}
