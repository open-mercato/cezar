import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SKILLS_BANNER_LINES, printSkillsBanner, shouldShowSkillsBanner } from './skills-banner.js';

/**
 * The banner's wiring and its two off switches (#391). `printSkillsBanner` is what `serve` calls,
 * so testing it — rather than the constant's copy — covers the parts that can actually break.
 */

let repoRoot: string;
let printed: (string | undefined)[];
const log = (line?: string) => void printed.push(line);

/** Writes `.ai/cezar/ui-state.json` verbatim, so a malformed file can be tested too. */
function writeUiState(raw: string): void {
  mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
  writeFileSync(join(repoRoot, '.ai/cezar', 'ui-state.json'), raw, 'utf8');
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'cez-banner-'));
  printed = [];
  delete process.env.CEZ_NO_BANNER;
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  delete process.env.CEZ_NO_BANNER;
});

describe('printSkillsBanner', () => {
  it('prints the promo when nothing has turned it off', async () => {
    await printSkillsBanner(repoRoot, log);
    const text = printed.join('\n');
    expect(text).toContain('open-mercato/skills');
    expect(text).toContain("npx skills add open-mercato/skills --skill '*'");
  });

  it('says WHY to install skills cezar already loads — the extra copy is for use outside cezar', async () => {
    await printSkillsBanner(repoRoot, log);
    const text = printed.join('\n');
    expect(text).toContain('cezar already loads them');
    expect(text).toContain('outside cezar');
  });

  it('is silent when CEZ_NO_BANNER=1', async () => {
    process.env.CEZ_NO_BANNER = '1';
    await printSkillsBanner(repoRoot, log);
    expect(printed).toEqual([]);
  });

  it('is silent once the cockpit banner has been dismissed — one story across both surfaces', async () => {
    writeUiState(JSON.stringify({ dismissedSkillsBanner: true }));
    await printSkillsBanner(repoRoot, log);
    expect(printed).toEqual([]);
  });

  it('prints when ui-state records other prefs but no dismissal', async () => {
    writeUiState(JSON.stringify({ runsView: 'table' }));
    await printSkillsBanner(repoRoot, log);
    expect(printed.join('\n')).toContain('open-mercato/skills');
  });

  it('prints when ui-state.json is missing — the zero-config default, not a crash', async () => {
    await expect(shouldShowSkillsBanner(repoRoot)).resolves.toBe(true);
  });

  it('prints when ui-state.json is malformed — degrades to shown, never throws', async () => {
    writeUiState('{not json');
    await expect(shouldShowSkillsBanner(repoRoot)).resolves.toBe(true);
    await printSkillsBanner(repoRoot, log);
    expect(printed.join('\n')).toContain('open-mercato/skills');
  });

  it('prints when ui-state.json holds a non-object — a truthy flag it cannot carry', async () => {
    writeUiState('"nope"');
    await expect(shouldShowSkillsBanner(repoRoot)).resolves.toBe(true);
  });

  it('honours only the exact 1 opt-out, like CEZ_DRY_RUN', async () => {
    process.env.CEZ_NO_BANNER = '0';
    await expect(shouldShowSkillsBanner(repoRoot)).resolves.toBe(true);
  });

  it('is a handful of short lines — a few lines in an already-chatty startup block', () => {
    expect(SKILLS_BANNER_LINES.length).toBeGreaterThan(0);
    expect(SKILLS_BANNER_LINES.length).toBeLessThanOrEqual(6);
    for (const line of SKILLS_BANNER_LINES) expect(line.length).toBeLessThanOrEqual(90);
  });

  it('emits no ANSI escapes — startup output stays readable when piped to a file', () => {
    const ESC = String.fromCharCode(27);
    for (const line of SKILLS_BANNER_LINES) expect(line).not.toContain(ESC);
  });
});
