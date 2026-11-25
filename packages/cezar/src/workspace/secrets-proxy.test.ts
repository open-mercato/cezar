import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secretBindingSchema, secretHostIssue, secretValueInputSchema, type SecretBinding } from '@open-mercato/cezar-contract';
import { SecretStore, SecretsError, type SecretScopeRef } from './secrets.ts';

const binding: SecretBinding = { hosts: ['api.example.com'], header: 'Authorization', scheme: 'bearer' };

describe('proxy audience and binding (fork #1)', () => {
  let home: string;
  let store: SecretStore;
  const workspace: SecretScopeRef = { kind: 'workspace' };
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cez-proxy-home-'));
    store = new SecretStore({ ...process.env, CEZ_HOME: home }, { keychain: async () => null });
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  describe('binding validation', () => {
    it.each(['*.example.com', 'API.example.com', 'api.example.com:443', '10.0.0.1', '[::1]', 'a b.com', 'a..com', '-a.com', 'https://a.com', 'a.com/x'])('refuses host %s', (host) => {
      expect(secretHostIssue(host)).not.toBeNull();
    });
    it('accepts exact lowercase hostnames', () => {
      expect(secretHostIssue('api.example.com')).toBeNull();
      expect(secretHostIssue('localhost')).toBeNull();
    });
    it('refuses empty hosts, bad headers, unknown schemes and unknown keys', () => {
      for (const bad of [
        { ...binding, hosts: [] },
        { ...binding, header: 'Bad Header' },
        { ...binding, header: 'Host' },
        { ...binding, scheme: 'digest' },
        { ...binding, sentinel: 'lower' },
        { ...binding, extra: 1 },
      ]) expect(secretBindingSchema.safeParse(bad).success).toBe(false);
      expect(secretBindingSchema.safeParse({ ...binding, sentinel: 'GH_TOKEN' }).success).toBe(true);
    });
    it('the store refuses a bad binding and a missing one', async () => {
      await expect(store.set(workspace, 'K', 'v', ['proxy'], { ...binding, hosts: ['*.x.com'] })).rejects.toThrow(SecretsError);
      await expect(store.set(workspace, 'K', 'v', ['proxy'])).rejects.toThrow(/needs a binding/);
    });
  });

  describe('exclusivity', () => {
    it.each([[['proxy', 'checks']], [['proxy', 'cezar']]] as const)('a proxy secret cannot also be %j', async (audiences) => {
      await expect(store.set(workspace, 'K', 'v', audiences, binding)).rejects.toThrow(/no other audience/);
    });
    it('other audiences cannot carry a binding', async () => {
      await expect(store.set(workspace, 'K', 'v', ['checks'], binding)).rejects.toThrow(/only a proxy secret/);
    });
    it('a proxy secret never reaches checks or cezar resolution', async () => {
      await store.set(workspace, 'P', 'proxy-value-1234', ['proxy'], binding);
      await store.set(workspace, 'C', 'checks-value-1234');
      expect((await store.resolve(undefined, 'checks')).values).toEqual({ C: 'checks-value-1234' });
      expect((await store.resolve(undefined, 'cezar')).values).toEqual({});
      await expect(store.resolve(undefined, 'proxy')).rejects.toThrow(SecretsError);
    });
    it('the route schema refuses a proxy audience', () => {
      expect(secretValueInputSchema.safeParse({ value: 'v', audiences: ['proxy'] }).success).toBe(false);
      expect(secretValueInputSchema.safeParse({ value: 'v', audiences: ['checks'] }).success).toBe(true);
    });
  });

  describe('storage and tamper detection', () => {
    const edit = async (change: (file: any) => void) => {
      const path = join(home, 'secrets', 'workspace.json');
      const file = JSON.parse(await readFile(path, 'utf8'));
      change(file);
      await writeFile(path, JSON.stringify(file));
      await chmod(path, 0o600);
    };
    beforeEach(async () => { await store.set(workspace, 'P', 'proxy-value-1234', ['proxy'], binding); });

    it('round-trips value and binding, sorting and deduplicating hosts', async () => {
      await store.set(workspace, 'Q', 'q-value-1234', ['proxy'], { ...binding, hosts: ['b.com', 'a.com', 'b.com'] });
      const read = await store.read(workspace);
      expect(read.values.P).toMatchObject({ value: 'proxy-value-1234', audiences: ['proxy'], binding });
      expect(read.values.Q?.binding?.hosts).toEqual(['a.com', 'b.com']);
      expect((await store.list(workspace)).secrets.find((s) => s.name === 'P')?.binding).toEqual(binding);
    });
    it('an edited host fails to open', async () => {
      await edit((f) => { f.secrets.P.binding.hosts = ['evil.example.com']; });
      const read = await store.read(workspace);
      expect(read.values).toEqual({});
      expect(read.skipped).toMatch(/does not decrypt/);
    });
    it.each(['header', 'scheme'] as const)('an edited %s fails to open', async (field) => {
      await edit((f) => { f.secrets.P.binding[field] = field === 'header' ? 'X-Other' : 'raw'; });
      expect((await store.read(workspace)).values).toEqual({});
    });
    it('a removed binding, or audiences widened to checks, is refused as a corrupt file', async () => {
      await edit((f) => { delete f.secrets.P.binding; });
      expect((await store.read(workspace)).skipped).toMatch(/corrupt/);
      await store.set(workspace, 'P', 'proxy-value-1234', ['proxy'], binding);
      await edit((f) => { f.secrets.P.audiences = ['proxy', 'checks']; });
      expect((await store.read(workspace)).skipped).toMatch(/corrupt/);
      expect((await store.resolve(undefined, 'checks')).values).toEqual({});
    });
    it('a binding grafted onto a checks secret is refused', async () => {
      await store.set(workspace, 'C', 'checks-value-1234');
      await edit((f) => { f.secrets.C.binding = binding; });
      expect((await store.read(workspace)).skipped).toMatch(/corrupt/);
    });
    it('files written before the proxy audience still read', async () => {
      await store.set(workspace, 'OLD', 'old-value-1234');
      const raw = JSON.parse(await readFile(join(home, 'secrets', 'workspace.json'), 'utf8'));
      expect(raw.secrets.OLD.binding).toBeUndefined();
      expect(raw.version).toBe(1);
      expect((await store.read(workspace)).values.OLD?.value).toBe('old-value-1234');
    });
  });

  describe('resolveProxy', () => {
    it('returns bound secrets, project winning on a shared name', async () => {
      const root = await mkdtemp(join(tmpdir(), 'cez-proxy-root-'));
      try {
        const project = { projectId: 'demo', root };
        await store.set(workspace, 'P', 'workspace-value-1', ['proxy'], binding);
        await store.set({ kind: 'project', ...project }, 'P', 'project-value-12', ['proxy'], { ...binding, hosts: ['p.example.com'] });
        const { secrets } = await store.resolveProxy(project, ['P']);
        expect(secrets).toEqual([{ name: 'P', value: 'project-value-12', binding: { ...binding, hosts: ['p.example.com'] } }]);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('is all or nothing: a missing or non-proxy name returns no value', async () => {
      await store.set(workspace, 'P', 'proxy-value-1234', ['proxy'], binding);
      await store.set(workspace, 'C', 'checks-value-1234');
      for (const names of [['P', 'MISSING'], ['P', 'C']]) {
        const result = await store.resolveProxy(undefined, names);
        expect(result.secrets).toEqual([]);
        expect(result.problems.join(' ')).not.toMatch(/value-1234/);
      }
    });
  });
});
