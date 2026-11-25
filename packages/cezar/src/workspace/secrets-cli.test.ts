import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSecretsCommand } from './secrets-cli.ts';
import { SecretStore } from './secrets.ts';
import { registerProject } from './projects.ts';

describe('cezar secrets (spec 2026-10-10-project-secrets-vault-options)', () => {
  let root: string;
  let lines: string[];
  let errors: string[];
  let store: SecretStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-secrets-cli-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    lines = [];
    errors = [];
    store = new SecretStore(process.env, { keychain: async () => null });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const cli = (args: string[], value?: string) =>
    runSecretsCommand([...args, '--repo', root], {
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
      ...(value === undefined ? {} : { readValue: async () => value }),
    }, process.env, store);

  it('sets from stdin, lists names with audiences and the key backend, and unsets — never a value', async () => {
    await registerProject(root);
    expect(await cli(['set', 'E2E_KEY'], 'cli-secret-value')).toBe(0);
    expect(await cli(['set', 'LLM_KEY', '--audience', 'cezar,checks'], 'cli-llm-value')).toBe(0);
    expect(await cli(['list'])).toBe(0);
    expect(await cli(['unset', 'E2E_KEY'])).toBe(0);
    expect(await cli(['list'])).toBe(0);
    expect(lines).toEqual(['E2E_KEY', 'LLM_KEY', 'E2E_KEY\tchecks', 'LLM_KEY\tcezar,checks', 'E2E_KEY', 'LLM_KEY\tcezar,checks']);
    expect(errors.some((line) => /key file|keychain/.test(line))).toBe(true);
    expect([...lines, ...errors].join('\n')).not.toMatch(/cli-secret-value|cli-llm-value/);
  });

  it('addresses the workspace with --workspace, without needing a registered project', async () => {
    expect(await cli(['set', 'SHARED', '--workspace'], 'workspace-value')).toBe(0);
    expect(await cli(['list', '--workspace'])).toBe(0);
    expect(lines).toEqual(['SHARED', 'SHARED\tchecks']);
    expect((await store.read({ kind: 'workspace' })).values.SHARED?.value).toBe('workspace-value');
    expect(await cli(['list'])).toBe(1);
    expect(errors.at(-1)).toContain('not a registered cezar project');
  });

  it('never takes a value from argv, and refuses any other operand or flag shape', async () => {
    await registerProject(root);
    expect(await cli(['set', 'E2E_KEY', 'inline-value'])).toBe(1);
    expect(errors.join('\n')).toContain('Usage');
    for (const args of [[], ['list', 'EXTRA'], ['set'], ['unset'], ['nonsense'], ['set', 'K', '--audience'], ['set', 'K', '--audience', 'agents'], ['unset', 'K', '--audience', 'checks']]) {
      expect(await cli(args, 'v')).toBe(1);
      expect(errors.at(-1)).toContain('Usage');
    }
  });

  it('refuses a reserved name, reports a missing name and an empty value', async () => {
    await registerProject(root);
    expect(await cli(['set', 'CEZ_RUN_ID'], 'x')).toBe(1);
    expect(errors.at(-1)).toContain('reserved');
    expect(await cli(['unset', 'MISSING'])).toBe(1);
    expect(errors.at(-1)).toContain('no secret named MISSING');
    expect(await cli(['set', 'E2E_KEY'], '')).toBe(1);
    expect(errors.at(-1)).toContain('empty value');
  });
});

describe('cezar secrets proxy binding and resolve (fork #1)', () => {
  let root: string;
  let lines: string[];
  let errors: string[];
  let store: SecretStore;
  let ring: Buffer | null;
  const keychain = async () => ({ get: async () => ring, set: async (key: Buffer) => { ring = key; } });
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-secrets-proxy-cli-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    lines = [];
    errors = [];
    ring = null;
    store = new SecretStore(process.env, { keychain: async () => null });
    await registerProject(root);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const cli = (args: string[], value?: string, tty = false, using: SecretStore = store) =>
    runSecretsCommand([...args, '--repo', root], {
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
      stdoutIsTTY: tty,
      ...(value === undefined ? {} : { readValue: async () => value }),
    }, process.env, using);
  const setProxy = (name = 'GH', using: SecretStore = store, extra: string[] = []) =>
    cli(['set', name, '--audience', 'proxy', '--host', 'api.github.com', '--header', 'Authorization', '--scheme', 'bearer', ...extra], 'ghp-proxy-secret-value', false, using);

  it('sets a bound proxy secret and lists its destination, never the value', async () => {
    expect(await setProxy('GH', store, ['--sentinel', 'GH_TOKEN'])).toBe(0);
    expect(await cli(['list'])).toBe(0);
    expect(lines).toContain('GH\tproxy\tapi.github.com Authorization bearer');
    expect([...lines, ...errors].join('\n')).not.toContain('ghp-proxy-secret-value');
  });

  it('refuses proxy without a complete binding, and binding flags without proxy', async () => {
    for (const args of [
      ['set', 'GH', '--audience', 'proxy'],
      ['set', 'GH', '--audience', 'proxy', '--host', 'a.com', '--header', 'Authorization'],
      ['set', 'GH', '--audience', 'proxy', '--host', '*.a.com', '--header', 'Authorization', '--scheme', 'bearer'],
      ['set', 'GH', '--audience', 'proxy', '--host', 'a.com', '--header', 'Authorization', '--scheme', 'digest'],
      ['set', 'GH', '--host', 'a.com'],
    ]) {
      expect(await cli(args, 'v')).toBe(1);
      expect(errors.at(-1)).toContain('Usage');
    }
  });

  it('resolve prints NAME value for named proxy secrets with a keychain key', async () => {
    const keyed = new SecretStore(process.env, { keychain });
    expect(await setProxy('GH', keyed)).toBe(0);
    expect(await cli(['resolve', 'GH'], undefined, false, keyed)).toBe(0);
    expect(lines.at(-1)).toBe('GH ghp-proxy-secret-value');
  });

  it('refuses proxy combined with another audience', async () => {
    expect(await cli(['set', 'GH', '--audience', 'proxy,checks', '--host', 'a.com', '--header', 'Authorization', '--scheme', 'bearer'], 'v')).toBe(1);
    expect(errors.at(-1)).toContain('no other audience');
  });

  it('resolve refuses a file-fallback key unless --allow-file-key', async () => {
    await setProxy();
    expect(await cli(['resolve', 'GH'])).toBe(1);
    expect(errors.at(-1)).toContain('--allow-file-key');
    expect(lines.filter((l) => l.includes('ghp-proxy'))).toEqual([]);
    expect(await cli(['resolve', 'GH', '--allow-file-key'])).toBe(0);
    expect(lines.at(-1)).toBe('GH ghp-proxy-secret-value');
  });

  it('resolve refuses a terminal', async () => {
    await setProxy();
    expect(await cli(['resolve', 'GH', '--allow-file-key'], undefined, true)).toBe(1);
    expect(errors.at(-1)).toContain('terminal');
    expect(lines.filter((l) => l.includes('ghp-proxy'))).toEqual([]);
  });

  it('resolve never prints a secret without a binding, and prints nothing when any name fails', async () => {
    await setProxy();
    await cli(['set', 'PLAIN'], 'plain-checks-value');
    lines.length = 0;
    expect(await cli(['resolve', 'PLAIN', '--allow-file-key'])).toBe(1);
    expect(await cli(['resolve', 'GH', 'MISSING', '--allow-file-key'])).toBe(1);
    expect(await cli(['resolve', 'GH', 'PLAIN', '--allow-file-key'])).toBe(1);
    expect(lines).toEqual([]);
    expect(errors.join('\n')).not.toMatch(/plain-checks-value|ghp-proxy/);
  });

  it('resolve takes names only: no value operand shape, no audience, no binding flag', async () => {
    for (const args of [['resolve'], ['resolve', 'GH', '--audience', 'proxy'], ['resolve', 'GH', '--host', 'a.com'], ['list', '--allow-file-key']]) {
      expect(await cli(args)).toBe(1);
      expect(errors.at(-1)).toContain('Usage');
    }
  });
});
