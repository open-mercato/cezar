import { homedir } from 'node:os';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secretNameIssue } from '@open-mercato/cezar-contract';
import type { DataKeyring } from './secret-keyring.ts';
import { SecretStore, SecretsError, parseSecretFile, type SecretScopeRef } from './secrets.ts';

/** An in-memory keychain: what the OS one does, minus the OS. `null` from the factory = none here. */
function fakeKeychain(initial?: Buffer): DataKeyring & { key: Buffer | null; sets: number } {
  const ring = {
    key: initial ?? null,
    sets: 0,
    async get() { return ring.key; },
    async set(key: Buffer) { ring.key = key; ring.sets++; },
  };
  return ring;
}

describe('SecretStore (spec 2026-10-10-project-secrets-vault-options)', () => {
  let home: string;
  let root: string;
  let store: SecretStore;
  let project: SecretScopeRef & { kind: 'project' };
  const workspace: SecretScopeRef = { kind: 'workspace' };
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, CEZ_HOME: home });
  /** Default: no keychain on this machine — the file fallback, which must always work. */
  const noKeychain = async () => null;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cez-secrets-home-'));
    root = await mkdtemp(join(tmpdir(), 'cez-secrets-root-'));
    store = new SecretStore(env(), { keychain: noKeychain });
    project = { kind: 'project', projectId: 'demo', root };
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  it('writes 0600 files inside a 0700 directory that ignores itself, and never the value in the clear', async () => {
    await store.set(project, 'E2E_KEY', 'value-1-with-enough-length');
    const dir = join(home, 'secrets');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'demo.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, '.key'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('*');
    const raw = await readFile(join(dir, 'demo.json'), 'utf8');
    expect(raw).not.toContain('value-1-with-enough-length');
    expect(raw).toContain('"E2E_KEY"');
    expect((await store.read(project)).values.E2E_KEY).toMatchObject({ value: 'value-1-with-enough-length', audiences: ['checks'] });
    expect(await store.keyBackend()).toBe('file');
  });

  it('lists names with audiences, sorted, and removes one', async () => {
    await store.set(project, 'ZED', 'z-value', ['checks', 'cezar']);
    await store.set(project, 'ALPHA', 'a-value', ['cezar']);
    const listed = await store.list(project);
    expect(listed.secrets.map((s) => [s.name, s.audiences])).toEqual([['ALPHA', ['cezar']], ['ZED', ['checks', 'cezar']]]);
    expect(listed.skipped).toBeUndefined();
    expect(await store.unset(project, 'ZED')).toBe(true);
    expect(await store.unset(project, 'ZED')).toBe(false);
    expect((await store.list(project)).secrets.map((s) => s.name)).toEqual(['ALPHA']);
  });

  it('keeps the data key in the keychain when one is usable, and in a file otherwise', async () => {
    const ring = fakeKeychain();
    const vaulted = new SecretStore(env(), { keychain: async () => ring });
    expect(await vaulted.keyBackend()).toBe('keychain');
    await vaulted.set(workspace, 'LLM_KEY', 'sk-workspace-key-0123456789', ['cezar']);
    expect(ring.sets).toBe(1);
    expect(ring.key?.length).toBe(32);
    await expect(stat(join(home, 'secrets', '.key'))).rejects.toMatchObject({ code: 'ENOENT' });
    // A second process on the same machine finds the same key in the keychain.
    const again = new SecretStore(env(), { keychain: async () => ring });
    expect((await again.read(workspace)).values.LLM_KEY?.value).toBe('sk-workspace-key-0123456789');
    expect(await again.keyBackend()).toBe('keychain');

    // No keychain: the same store falls back to a 0600 key file and says so.
    expect(await store.keyBackend()).toBe('file');
    await store.set(workspace, 'OTHER', 'other-value');
    expect((await stat(join(home, 'secrets', '.key'))).mode & 0o777).toBe(0o600);
  });

  it('falls back to the key file when the keychain refuses the write', async () => {
    const refusing: DataKeyring = { async get() { return null; }, async set() { throw new Error('locked'); } };
    const fallback = new SecretStore(env(), { keychain: async () => refusing });
    await fallback.set(project, 'KEY', 'a-value-long-enough');
    expect(await fallback.keyBackend()).toBe('file');
    expect((await fallback.read(project)).values.KEY?.value).toBe('a-value-long-enough');
  });

  it('reads as empty, with a reason, when the data key no longer decrypts the store', async () => {
    const ring = fakeKeychain();
    const vaulted = new SecretStore(env(), { keychain: async () => ring });
    await vaulted.set(project, 'KEY', 'a-value-long-enough');
    // The keychain was reset: a fresh key, the old ciphertext.
    const reset = new SecretStore(env(), { keychain: async () => fakeKeychain(Buffer.alloc(32, 7)) });
    const read = await reset.read(project);
    expect(read.values).toEqual({});
    expect(read.skipped).toMatch(/does not decrypt/);
    // The key is gone entirely: a different reason, same degradation.
    const gone = new SecretStore(env(), { keychain: async () => fakeKeychain() });
    expect((await gone.read(project)).skipped).toMatch(/data key is gone/);
  });

  it('binds a ciphertext to its file and name — a value moved between slots does not decrypt', async () => {
    await store.set(project, 'A', 'value-for-a-slot-only');
    const path = join(home, 'secrets', 'demo.json');
    const file = JSON.parse(await readFile(path, 'utf8')) as { secrets: Record<string, unknown> };
    file.secrets.B = file.secrets.A;
    await writeFile(path, JSON.stringify(file), { mode: 0o600 });
    const read = await store.read(project);
    expect(read.values).toEqual({});
    expect(read.skipped).toMatch(/does not decrypt/);
  });

  it.each([
    ['lowercase', 'e2e_key'],
    ['leading digit', '1KEY'],
    ['too long', `K${'A'.repeat(128)}`],
    ['cezar namespace', 'CEZ_RUN_ID'],
    ['loader', 'DYLD_INSERT_LIBRARIES'],
    ['shell', 'PATH'],
    ['shell', 'BASH_ENV'],
    ['node', 'NODE_OPTIONS'],
    ['loader', 'LD_PRELOAD'],
    ['temp dir', 'TMPDIR'],
  ])('refuses a %s name (%s) with a reason, never a silent drop', async (_class, name) => {
    expect(secretNameIssue(name)).toBeTruthy();
    await expect(store.set(project, name, 'x')).rejects.toBeInstanceOf(SecretsError);
  });

  it('refuses empty, multi-line and oversized values, and an empty audience list', async () => {
    await expect(store.set(project, 'KEY', 'a\nB=b')).rejects.toBeInstanceOf(SecretsError);
    await expect(store.set(project, 'KEY', 'x'.repeat(16 * 1024 + 1))).rejects.toBeInstanceOf(SecretsError);
    // An empty value would SHADOW the server's own variable of that name with '' rather than
    // read as unset, so the store refuses it exactly as the CLI and the cockpit do.
    await expect(store.set(project, 'KEY', '')).rejects.toThrow(/not empty/);
    await expect(store.set(project, 'KEY', 'fine', [])).rejects.toThrow(/at least one audience/);
    expect((await store.list(project)).secrets).toEqual([]);
  });

  it('reports a store it found but could not use, and stays quiet when there is none', async () => {
    expect(await store.read(project)).toEqual({ values: {} });
    await store.set(project, 'KEY', 'v-long-enough');
    expect((await store.read(project)).skipped).toBeUndefined();

    const other = await mkdtemp(join(tmpdir(), 'cez-secrets-other-'));
    try {
      const mismatch = await store.read({ ...project, root: other });
      expect(mismatch.values).toEqual({});
      expect(mismatch.skipped).toMatch(/belongs to another project root/);
    } finally {
      await rm(other, { recursive: true, force: true });
    }

    await writeFile(join(home, 'secrets', 'demo.json'), 'not json', { mode: 0o600 });
    const corrupt = await store.read(project);
    expect(corrupt.values).toEqual({});
    expect(corrupt.skipped).toMatch(/corrupt/);

    await writeFile(join(home, 'secrets', 'demo.json'), 'x'.repeat(1024 * 1024 + 10), { mode: 0o600 });
    expect((await store.read(project)).skipped).toMatch(/unusable/);
  });

  it('round-trips values with quotes, = and unicode exactly', async () => {
    const value = `"quoted" it's a=b c — ż ✓`;
    await store.set(project, 'KEY', value);
    expect((await store.read(project)).values.KEY?.value).toBe(value);
  });

  it('keeps every write under concurrent writers, sharing one data key', async () => {
    const names = Array.from({ length: 20 }, (_, i) => `KEY_${i}`);
    // Separate store instances, as two processes (cockpit + CLI) would be.
    await Promise.all(names.map((name) => new SecretStore(env(), { keychain: noKeychain }).set(project, name, `${name.toLowerCase()}-value`)));
    const read = await store.read(project);
    expect(Object.keys(read.values).sort()).toEqual([...names].sort());
    expect(read.skipped).toBeUndefined();
  });

  it('does not follow a symlinked file', async () => {
    await store.set(project, 'KEY', 'real-value-long-enough');
    const target = join(home, 'elsewhere.json');
    await writeFile(target, await readFile(join(home, 'secrets', 'demo.json')), { mode: 0o600 });
    await rm(join(home, 'secrets', 'demo.json'));
    await symlink(target, join(home, 'secrets', 'demo.json'));
    const read = await store.read(project);
    expect(read.values).toEqual({});
    expect(read.skipped).toBeTruthy();
  });

  it('never hands one repository\'s values to another that took over its project id', async () => {
    await store.set(project, 'KEY', 'first-owner-value');
    const other = await mkdtemp(join(tmpdir(), 'cez-secrets-other-'));
    try {
      const taken = { ...project, root: other };
      expect((await store.read(taken)).values).toEqual({});
      // The new owner's first write starts the file over instead of inheriting the key.
      await store.set(taken, 'OTHER', 'mine-long-enough');
      expect(Object.keys((await store.read(taken)).values)).toEqual(['OTHER']);
      expect((await store.read(project)).values).toEqual({});
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('refuses a project id that is not a slug, and never writes a file for it', async () => {
    expect(await store.read({ ...project, projectId: '../escape' })).toEqual({ values: {} });
    await expect(store.set({ ...project, projectId: '../escape' }, 'KEY', 'v-long-enough')).rejects.toThrow(/invalid project id/);
    // `workspace` is the workspace file's own id; a project cannot alias it.
    await expect(store.set({ ...project, projectId: 'workspace' }, 'KEY', 'v-long-enough')).rejects.toThrow(/invalid project id/);
  });

  it('trips the sandbox guard when a test would write the real cezar home', async () => {
    const unpinned = new SecretStore({ ...process.env, CEZ_HOME: join(homedir(), '.cezar') }, { keychain: noKeychain });
    await expect(unpinned.set(project, 'KEY', 'v-long-enough')).rejects.toThrow(/refusing to write/);
  });

  it('refuses a file shape this cezar never writes', () => {
    expect(() => parseSecretFile('{"version":2,"secrets":{}}')).toThrow(SecretsError);
    expect(() => parseSecretFile('[]')).toThrow(SecretsError);
    expect(parseSecretFile('{"version":1,"secrets":{}}')).toEqual({ version: 1, secrets: {} });
  });

  describe('resolve', () => {
    beforeEach(async () => {
      await store.set(workspace, 'SHARED', 'workspace-shared-value');
      await store.set(workspace, 'LLM_KEY', 'workspace-llm-key-value', ['cezar']);
      await store.set(project, 'SHARED', 'project-shared-value');
      await store.set(project, 'E2E_KEY', 'project-e2e-key-value');
      await store.set(project, 'BOTH', 'project-both-value', ['checks', 'cezar']);
    });

    it('hands an audience every secret that admits it, the project winning on a shared name', async () => {
      const checks = await store.resolve(project, 'checks');
      expect(checks.values).toEqual({ SHARED: 'project-shared-value', E2E_KEY: 'project-e2e-key-value', BOTH: 'project-both-value' });
      expect(checks.notes).toEqual([]);
      const cezar = await store.resolve(project, 'cezar');
      expect(cezar.values).toEqual({ LLM_KEY: 'workspace-llm-key-value', BOTH: 'project-both-value' });
    });

    it('serves the workspace alone when there is no project', async () => {
      expect((await store.resolve(undefined, 'checks')).values).toEqual({ SHARED: 'workspace-shared-value' });
    });

    it('honours bindings: exactly the named secrets, renamed on request, and says what it could not meet', async () => {
      const bound = await store.resolve(project, 'checks', ['E2E_KEY', { name: 'SHARED', as: 'APP_TOKEN' }, 'LLM_KEY', 'MISSING']);
      expect(bound.values).toEqual({ E2E_KEY: 'project-e2e-key-value', APP_TOKEN: 'project-shared-value' });
      expect(bound.notes).toEqual([
        'secret LLM_KEY is not available to checks (audiences: cezar)',
        'secret MISSING is not stored for this project or workspace',
      ]);
    });

    it('reports a skipped store once, then serves what the other scope has', async () => {
      await writeFile(join(home, 'secrets', 'workspace.json'), 'broken', { mode: 0o600 });
      const resolved = await store.resolve(project, 'checks');
      expect(resolved.values).toEqual({ SHARED: 'project-shared-value', E2E_KEY: 'project-e2e-key-value', BOTH: 'project-both-value' });
      expect(resolved.notes).toEqual(['workspace secrets skipped — the store file is corrupt — not JSON']);
    });
  });
});
