import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptSuggestions, dismissSuggestions, loadProposal, noteInstalls } from './containerfile-store.ts';
import { renderContainerfile } from './containerfile-suggest.ts';

describe('containerfile proposal store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cez-cf-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a DISMISSED command is never written into the Containerfile', () => {
    // The bug this pins: dismissed commands used to be folded into `accepted`
    // ("accepted means decided"), and accept rebuilds the whole file from
    // `accepted` — so refusing one command and later accepting an unrelated
    // one wrote the refused one in.
    noteInstalls(dir, 'npm i -g something-junk');
    noteInstalls(dir, 'apt-get install -y jq');
    dismissSuggestions(dir, ['npm install -g something-junk']);

    acceptSuggestions(
      dir, dir, 'Containerfile',
      ['apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*'],
      renderContainerfile,
    );

    const written = readFileSync(join(dir, 'Containerfile'), 'utf8');
    expect(written).toContain('jq');
    expect(written).not.toContain('something-junk');
  });

  it('neither accepted nor dismissed commands are proposed again', () => {
    noteInstalls(dir, 'gem install bundler');
    dismissSuggestions(dir, ['gem install bundler']);
    noteInstalls(dir, 'gem install bundler');
    expect(loadProposal(dir).pending).toHaveLength(0);
  });

  it('ignores a project\'s own dependency install, so nothing is proposed', () => {
    noteInstalls(dir, 'pnpm install --frozen-lockfile');
    expect(loadProposal(dir).pending).toHaveLength(0);
  });
});
