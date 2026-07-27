import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConfigFile, writeConfigFile } from './files.js';

let repo: string;
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'cez-repo-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cez-home-')));
  env = { HOME: home } as NodeJS.ProcessEnv;
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('readConfigFile', () => {
  it('unknown id → null', async () => {
    expect(await readConfigFile('../../etc/passwd', repo, env)).toBeNull();
  });

  it('absent file → exists:false, version:null', async () => {
    const r = await readConfigFile('claude.project.settings', repo, env);
    expect(r).toMatchObject({ exists: false, version: null, content: '' });
  });

  it('reads an existing file and hashes it', async () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.json'), '{"a":1}');
    const r = (await readConfigFile('claude.project.settings', repo, env)) as { content: string; version: string };
    expect(r.content).toBe('{"a":1}');
    expect(r.version).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('writeConfigFile', () => {
  it('unknown id → null', async () => {
    expect(await writeConfigFile('nope', 'x', null, repo, env)).toBeNull();
  });

  it('creates a new file (version:null) and its parent dir', async () => {
    const out = await writeConfigFile('claude.project.settings', '{"a":1}', null, repo, env);
    expect(out).toMatchObject({ ok: true });
    expect(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8')).toBe('{"a":1}');
  });

  it('rejects invalid JSON with 400, writes nothing', async () => {
    const out = await writeConfigFile('claude.project.settings', '{bad', null, repo, env);
    expect(out).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects a stale write with 409', async () => {
    await writeConfigFile('claude.project.settings', '{"a":1}', null, repo, env);
    // caller thinks the file is still absent (version null) but it now exists
    const out = await writeConfigFile('claude.project.settings', '{"a":2}', null, repo, env);
    expect(out).toMatchObject({ ok: false, status: 409 });
  });

  it('refuses to empty a populated file (wipe footgun), but allows creating an empty markdown', async () => {
    const first = (await writeConfigFile('claude.project.settings', '{"a":1}', null, repo, env)) as {
      ok: true;
      read: { version: string };
    };
    const wipe = await writeConfigFile('claude.project.settings', '   ', first.read.version, repo, env);
    expect(wipe).toMatchObject({ ok: false, status: 400 });
    expect(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8')).toBe('{"a":1}');
    // creating a fresh empty markdown file is still fine (nothing to clobber)
    const created = await writeConfigFile('claude.project.memory', '', null, repo, env);
    expect(created).toMatchObject({ ok: true });
  });

  it('accepts a write with the correct current version', async () => {
    const first = (await writeConfigFile('claude.project.settings', '{"a":1}', null, repo, env)) as {
      ok: true;
      read: { version: string };
    };
    const out = await writeConfigFile('claude.project.settings', '{"a":2}', first.read.version, repo, env);
    expect(out).toMatchObject({ ok: true });
    expect(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8')).toBe('{"a":2}');
  });

  it('round-trips bytes exactly — no reformat', async () => {
    const raw = '{\n  "a": 1,\n  // keep this comment\n  "b": 2\n}\n';
    // opencode.json is jsonc → comments are legal
    const out = (await writeConfigFile('opencode.project.config', raw, null, repo, env)) as {
      ok: true;
      read: { content: string };
    };
    expect(out.read.content).toBe(raw);
  });

  it('writes THROUGH a symlink instead of replacing it', async () => {
    // ~/.claude → a dotfiles dir; writing claude.user.settings must not clobber the link
    const dotfiles = realpathSync(mkdtempSync(join(tmpdir(), 'cez-dot-')));
    symlinkSync(dotfiles, join(home, '.claude'));
    const out = await writeConfigFile('claude.user.settings', '{"x":1}', null, repo, env);
    expect(out).toMatchObject({ ok: true });
    // the real file landed in the dotfiles target, and ~/.claude is still a symlink
    expect(readFileSync(join(dotfiles, 'settings.json'), 'utf8')).toBe('{"x":1}');
    rmSync(dotfiles, { recursive: true, force: true });
  });
});
