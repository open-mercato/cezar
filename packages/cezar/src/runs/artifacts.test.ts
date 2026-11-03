import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  artifactsCdnEnabled,
  artifactsPromptPart,
  extractTitle,
  findArtifact,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACTS,
  scanArtifacts,
} from './artifacts.ts';

describe('scanArtifacts (spec 2026-10-22-html-artifacts Q5)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-artifacts-scan-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('never throws on a missing directory', async () => {
    expect(await scanArtifacts(join(dir, 'absent'))).toEqual({ artifacts: [], truncated: false });
  });

  it('skips dotfiles, directories, symlinks and unaddressable names', async () => {
    writeFileSync(join(dir, 'ok.html'), '<title>Ok</title>');
    writeFileSync(join(dir, '.hidden.html'), 'x');
    writeFileSync(join(dir, 'with space.html'), 'x');
    mkdirSync(join(dir, 'folder'));
    mkdirSync(join(dir, '.versions'));
    symlinkSync(join(dir, 'ok.html'), join(dir, 'link.html'));
    const { artifacts } = await scanArtifacts(dir);
    expect(artifacts.map((a) => a.name)).toEqual(['ok.html']);
  });

  it('lists files one folder down as <folder>/<file>, and nothing deeper', async () => {
    mkdirSync(join(dir, 'shots', 'deeper'), { recursive: true });
    writeFileSync(join(dir, 'report.html'), '<title>R</title>');
    writeFileSync(join(dir, 'shots', 'a.png'), 'x');
    writeFileSync(join(dir, 'shots', '.hidden.png'), 'x');
    writeFileSync(join(dir, 'shots', 'deeper', 'b.png'), 'x');
    mkdirSync(join(dir, '.versions', '1'), { recursive: true });
    writeFileSync(join(dir, '.versions', '1', 'old.html'), 'x');
    symlinkSync(join(dir, 'shots'), join(dir, 'linked'));
    const { artifacts } = await scanArtifacts(dir);
    expect(artifacts.map((a) => [a.name, a.kind]).sort()).toEqual([
      ['report.html', 'html'],
      ['shots/a.png', 'image'],
    ]);
    expect((await scanArtifacts(dir, { nested: false })).artifacts.map((a) => a.name)).toEqual(['report.html']);
  });

  it('classifies by extension and lists newest first', async () => {
    const files = ['a.html', 'b.md', 'c.png', 'd.json', 'e.txt'];
    files.forEach((name, i) => {
      writeFileSync(join(dir, name), 'x');
      const t = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      utimesSync(join(dir, name), t, t);
    });
    const { artifacts } = await scanArtifacts(dir);
    expect(artifacts.map((a) => [a.name, a.kind])).toEqual([
      ['e.txt', 'other'],
      ['d.json', 'json'],
      ['c.png', 'image'],
      ['b.md', 'markdown'],
      ['a.html', 'html'],
    ]);
    expect(artifacts[4]!.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it(`caps the listing at ${MAX_ARTIFACTS} with truncated`, async () => {
    for (let i = 0; i < MAX_ARTIFACTS + 3; i++) writeFileSync(join(dir, `f${i}.txt`), 'x');
    const listing = await scanArtifacts(dir);
    expect(listing.artifacts).toHaveLength(MAX_ARTIFACTS);
    expect(listing.truncated).toBe(true);
  });

  it('caps the top level and the folders apart, so screenshots never push a page out', async () => {
    writeFileSync(join(dir, 'report.html'), 'x');
    utimesSync(join(dir, 'report.html'), new Date(0), new Date(0));
    mkdirSync(join(dir, 'shots'));
    for (let i = 0; i < MAX_ARTIFACTS + 16; i++) writeFileSync(join(dir, 'shots', `s${i}.png`), 'x');
    const listing = await scanArtifacts(dir);
    expect(listing.artifacts.map((a) => a.name)).toContain('report.html');
    expect(listing.artifacts.filter((a) => a.name.startsWith('shots/'))).toHaveLength(MAX_ARTIFACTS);
    expect(listing.truncated).toBe(true);
  });

  it("keeps a folder's page in the listing when another folder's screenshots fill the cap", async () => {
    mkdirSync(join(dir, 'site'));
    writeFileSync(join(dir, 'site', 'index.html'), '<title>Site</title>');
    utimesSync(join(dir, 'site', 'index.html'), new Date(0), new Date(0));
    mkdirSync(join(dir, 'shots'));
    for (let i = 0; i < MAX_ARTIFACTS + 6; i++) writeFileSync(join(dir, 'shots', `s${i}.png`), 'x');
    const listing = await scanArtifacts(dir);
    expect(listing.artifacts.find((a) => a.name === 'site/index.html')?.title).toBe('Site');
    expect(listing.artifacts.filter((a) => a.name.includes('/'))).toHaveLength(MAX_ARTIFACTS);
  });

  it('lists a file over 10 MB as other, whatever its extension', async () => {
    writeFileSync(join(dir, 'big.html'), '');
    truncateSync(join(dir, 'big.html'), MAX_ARTIFACT_BYTES + 1);
    const { artifacts } = await scanArtifacts(dir);
    expect(artifacts[0]).toMatchObject({ name: 'big.html', kind: 'other', size: MAX_ARTIFACT_BYTES + 1 });
    expect(artifacts[0]!.title).toBeUndefined();
  });

  it('reads titles from the first 8 KB only', async () => {
    writeFileSync(join(dir, 'late.html'), `${' '.repeat(9000)}<title>Too late</title>`);
    writeFileSync(join(dir, 'doc.md'), 'intro\n\n# The   heading #\n\n# second\n');
    const { artifacts } = await scanArtifacts(dir);
    expect(artifacts.find((a) => a.name === 'late.html')?.title).toBeUndefined();
    expect(artifacts.find((a) => a.name === 'doc.md')?.title).toBe('The heading');
  });
});

describe('findArtifact — the uncapped serving guard', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-artifacts-find-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds a file the listing cap left out, and nothing the scan would skip', async () => {
    mkdirSync(join(dir, 'shots'));
    for (let i = 0; i < MAX_ARTIFACTS + 5; i++) writeFileSync(join(dir, 'shots', `s${i}.png`), 'x');
    writeFileSync(join(dir, '.hidden.png'), 'x');
    mkdirSync(join(dir, '.versions'));
    writeFileSync(join(dir, '.versions', 'a.png'), 'x');
    symlinkSync(join(dir, 'shots'), join(dir, 'linked'));
    for (let i = 0; i < MAX_ARTIFACTS + 5; i++) {
      expect(await findArtifact(dir, `shots/s${i}.png`)).toMatchObject({ name: `shots/s${i}.png`, kind: 'image' });
    }
    for (const name of ['.hidden.png', '.versions/a.png', 'linked/s0.png', 'shots', 'shots/missing.png', 'a/b/c.png', '../x.png']) {
      expect(await findArtifact(dir, name), name).toBeNull();
    }
  });
});

describe('extractTitle', () => {
  it('decodes the common entities and collapses whitespace', () => {
    expect(extractTitle('html', '<TITLE lang="en">\n  A &amp; B &lt;v2&gt;\n</TITLE>')).toBe('A & B <v2>');
  });
  it('ignores an empty title and other kinds', () => {
    expect(extractTitle('html', '<title>  </title>')).toBeUndefined();
    expect(extractTitle('json', '# not a heading')).toBeUndefined();
  });
});

describe('the artifacts prompt line (O3)', () => {
  it('names the directory and the CDN rule by default', () => {
    const line = artifactsPromptPart('/data/artifacts/r1', true);
    expect(line).toContain('`/data/artifacts/r1`');
    expect(line).toContain('cdnjs, jsDelivr or unpkg with an exact pinned version');
    expect(line).toContain('no fetch/XHR to any host');
    expect(line).toContain('<img src="shots/a.png">');
  });
  it('asks for everything inline with CEZ_ARTIFACTS_CDN=0', () => {
    expect(artifactsCdnEnabled({ CEZ_ARTIFACTS_CDN: '0' })).toBe(false);
    expect(artifactsCdnEnabled({})).toBe(true);
    const line = artifactsPromptPart('/d', false);
    expect(line).toContain('Inline every script and style');
    expect(line).not.toContain('cdnjs');
  });
});
