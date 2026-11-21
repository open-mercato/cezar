import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseFrontmatter } from '../skills.js';
import { readHarnessFsEntry } from '../fs-read.js';

export interface TrustedHarnessSkillBinding {
  name: string;
  systemPrompt: string;
  sha256: string;
}

function hashSkillTree(root: string): string {
  const hash = createHash('sha256');
  const visit = (relative: string): void => {
    const path = relative ? join(root, relative) : root;
    const entry = readHarnessFsEntry(path);
    hash.update(`\0${relative}\0`);
    if (entry.kind === 'symlink') {
      hash.update('symlink\0');
      hash.update(entry.target);
      return;
    }
    if (entry.kind === 'other' && entry.stat.isDirectory()) {
      hash.update('directory\0');
      for (const child of readdirSync(path).sort()) {
        visit(relative ? join(relative, child) : child);
      }
      return;
    }
    hash.update('file\0');
    if (entry.kind === 'file') hash.update(entry.content!);
  };
  visit('');
  return hash.digest('hex');
}

/**
 * Render a system prompt from the exact force-materialized skill bytes. This
 * avoids the normal local-first catalog shadowing the skill while the ledger
 * hashes a different bundled copy.
 */
export function loadTrustedHarnessSkill(
  skillsRoot: string,
  name: string,
): TrustedHarnessSkillBinding {
  const path = join(skillsRoot, name, 'SKILL.md');
  const raw = readFileSync(path, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  const description =
    typeof frontmatter.description === 'string' && frontmatter.description.trim()
      ? frontmatter.description.trim()
      : undefined;
  const installedDir = dirname(path);
  const lines = [
    `Selected skill: /${name}`,
    ...(description ? [`Description: ${description}`] : []),
    '',
    `Skill files are installed on disk at: ${installedDir}`,
    'Read referenced files from that exact directory.',
    '',
    'Skill instructions:',
    body.trim(),
  ];
  return {
    name,
    systemPrompt: lines.join('\n'),
    sha256: hashSkillTree(dirname(path)),
  };
}
