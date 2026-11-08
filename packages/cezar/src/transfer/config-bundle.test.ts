import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configBundleSchema } from '@open-mercato/cezar-contract';
import { AutomationStore } from '../automations/store.ts';
import { configSchema } from '../config.ts';
import { SecretStore } from '../workspace/secrets.ts';
import { workspaceConfigSchema } from '../workspace/config.ts';
import { writeTrackerAssociation } from '../tracker-association.ts';
import {
  PROJECT_CONFIG_KEYS,
  PROJECT_EXCLUDED,
  WORKSPACE_EXCLUDED,
  WORKSPACE_KEYS,
  applyConfigBundle,
  buildConfigBundle,
  normalizeRemote,
  portableSkillsRepo,
  planConfigBundle,
  type BundleEnv,
  type BundlePlanEnv,
} from './config-bundle.ts';

const temps: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
const savedHome = process.env.CEZ_HOME;
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.env.CEZ_HOME = savedHome;
});

const REMOTE = 'github.com/acme/app';
const project = (id = 'app') => {
  const root = temp('cezar-bundle-root-');
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  return { id, name: id, root, remote: REMOTE };
};
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2));
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

const noChecks = { trackerTriggerIssue: async () => null, accountIssue: async () => null };
const planEnv: BundlePlanEnv = { automations: true, localHandoff: true, checksFor: () => noChecks };

describe('allowlists', () => {
  it('classifies every workspace and project config key as exported or excluded with a reason', () => {
    const classify = (keys: string[], exported: readonly string[], excluded: Record<string, string>) => {
      for (const key of keys) expect(exported.includes(key) || !!excluded[key], `unclassified key: ${key}`).toBe(true);
      for (const key of exported) expect(excluded[key], `${key} is both exported and excluded`).toBeUndefined();
    };
    classify(Object.keys(workspaceConfigSchema.shape), WORKSPACE_KEYS, WORKSPACE_EXCLUDED);
    // The process capability is derived after parsing, while optional file keys live on the input.
    classify([...new Set([...Object.keys(configSchema.in.shape), ...Object.keys(configSchema.parse({}))])], PROJECT_CONFIG_KEYS, PROJECT_EXCLUDED);
  });

  it('keeps skills repos portable: credentials stripped, local paths dropped', () => {
    expect(portableSkillsRepo('https://bob:ghp_SECRET123@github.com/org/skills.git')).toBe('https://github.com/org/skills.git');
    expect(portableSkillsRepo('ssh://git@github.com/org/skills.git')).toBe('ssh://git@github.com/org/skills.git');
    expect(portableSkillsRepo('git@github.com:org/skills.git')).toBe('git@github.com:org/skills.git');
    expect(portableSkillsRepo('org/skills')).toBe('org/skills');
    for (const local of ['/home/bob/private-skills', '~/skills', './skills', 'file:///srv/skills', 'C:\\skills']) {
      expect(portableSkillsRepo(local), local).toBeUndefined();
    }
  });

  it('normalizes a remote and strips any embedded credentials', () => {
    expect(normalizeRemote('https://user:ghp_secret@github.com/Acme/App.git')).toBe(REMOTE);
    expect(normalizeRemote('git@github.com:acme/app.git')).toBe(REMOTE);
    expect(normalizeRemote('/local/path')).toBeUndefined();
  });
});

describe('configuration bundle', () => {
  let homeA: string;
  let homeB: string;
  beforeEach(() => {
    homeA = temp('cezar-bundle-home-a-');
    homeB = temp('cezar-bundle-home-b-');
  });

  const envFor = (home: string): BundleEnv => {
    const secrets = new SecretStore({ ...process.env, CEZ_HOME: home }, { keychain: async () => null });
    return {
      automations: true,
      secretNames: async (scope) => (await secrets.list(scope)).secrets.map((entry) => entry.name),
      remoteOf: async () => REMOTE,
    };
  };

  it('never carries secret values, ciphertext, paths, consent or install identity', async () => {
    process.env.CEZ_HOME = homeA;
    const a = project();
    const secrets = new SecretStore({ ...process.env, CEZ_HOME: homeA }, { keychain: async () => null });
    await secrets.set({ kind: 'workspace' }, 'OPENAI_API_KEY', 'sk-workspace-value-123456');
    await secrets.set({ kind: 'project', projectId: a.id, root: a.root }, 'SENTRY_TOKEN', 'sentry-project-value-987654');
    writeJson(join(homeA, 'config.json'), {
      browseRoot: '/home/someone', projectsDir: '/home/someone/p', cezarId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      telemetry: { consent: 'granted', policyVersion: 1, decidedAt: 'x' },
      projects: [{ id: a.id, root: a.root, name: 'app', addedAt: '' }],
      systemPrompt: 'Be brief', modelsLocked: true,
      orgSkillsRepos: [{ repo: 'https://bob:ghp_SECRET123@github.com/org/skills.git', ref: 'main' }, { repo: '/home/someone/private-skills', ref: 'main' }],
    });
    writeJson(join(a.root, '.ai/cezar/config.json'), { skillsRepos: [{ repo: '/home/someone/local', ref: 'main' }, { repo: 'org/team', ref: 'main' }] });
    const associated = await writeTrackerAssociation(join(a.root, '.ai/cezar'), {
      kind: 'jira', connectionId: 'c'.repeat(64), externalId: 'P', externalName: 'Project', source: { id: 's', webUrl: 'https://example.atlassian.net' },
    } as never);

    const bundle = await buildConfigBundle([a], envFor(homeA), { cezarVersion: 'test' });
    const text = JSON.stringify(bundle);
    expect(configBundleSchema.safeParse(JSON.parse(text)).success).toBe(true);
    expect(bundle.workspace).toEqual({ systemPrompt: 'Be brief', modelsLocked: true, orgSkillsRepos: [{ repo: 'https://github.com/org/skills.git', ref: 'main' }] });
    expect(bundle.projects[0]!.config).toEqual({ skillsRepos: [{ repo: 'org/team', ref: 'main' }] });
    expect(bundle.reminders.workspaceSecretNames).toEqual(['OPENAI_API_KEY']);
    expect(bundle.projects[0]!.reminders.secretNames).toEqual(['SENTRY_TOKEN']);
    if (associated) expect(bundle.projects[0]!.reminders.tracker).toBe('jira');
    for (const leaked of ['ghp_SECRET123', 'bob:', 'sk-workspace-value', 'sentry-project-value', '/home/someone', a.root, homeA, 'cezarId', 'telemetry', '"ciphertext"', '"iv"']) {
      expect(text, `bundle leaked ${leaked}`).not.toContain(leaked);
    }
    for (const file of ['secrets']) expect(text).not.toContain(readdirText(join(homeA, file)));
  });

  it('round-trips into a project matched by remote, landing automations paused', async () => {
    process.env.CEZ_HOME = homeA;
    const a = project();
    writeJson(join(a.root, '.ai/cezar/config.json'), { defaultRunner: 'codex', branchNaming: 'feat/<slug>', landing: 'auto', worktreeLifecycle: { afterCreate: [], beforeRemove: [] } });
    writeJson(join(a.root, '.ai/cezar/ui-state.json'), { promptTemplates: [{ id: 't1', label: 'Fix', text: 'Fix it' }], unrelated: true });
    AutomationStore.open(join(a.root, '.ai/cezar')).create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4 }, task: { prompt: 'tidy' } });
    writeJson(join(homeA, 'config.json'), { systemPrompt: 'Be brief' });
    const bundle = configBundleSchema.parse(JSON.parse(JSON.stringify(await buildConfigBundle([a], envFor(homeA)))));
    expect(bundle.projects[0]!.config).toEqual({ defaultRunner: 'codex', branchNaming: 'feat/<slug>' });

    process.env.CEZ_HOME = homeB;
    const b = project('mine');
    const plan = await planConfigBundle(bundle, {}, [b], planEnv);
    expect(plan.preview.projects[0]).toMatchObject({ match: 'remote', targetProjectId: 'mine' });
    expect(plan.preview.sections.map((s) => [s.id, s.selected])).toEqual([
      ['workspace', true], ['project:0:config', true], ['project:0:promptTemplates', true], ['project:0:automations', true],
    ]);
    const applied = await applyConfigBundle(plan);
    expect(applied).toHaveLength(4);
    expect(readJson(join(homeB, 'config.json')).systemPrompt).toBe('Be brief');
    expect(readJson(join(b.root, '.ai/cezar/config.json'))).toEqual({ defaultRunner: 'codex', branchNaming: 'feat/<slug>' });
    expect(readJson(join(b.root, '.ai/cezar/ui-state.json')).promptTemplates).toEqual([{ id: 't1', label: 'Fix', text: 'Fix it' }]);
    const imported = AutomationStore.open(join(b.root, '.ai/cezar')).list();
    expect(imported).toEqual([expect.objectContaining({ name: 'Nightly', enabled: false })]);
  });

  it('keeps the target value on a conflicting key unless the user takes the imported one', async () => {
    process.env.CEZ_HOME = homeB;
    const b = project();
    writeJson(join(b.root, '.ai/cezar/config.json'), { defaultRunner: 'claude', keepMe: 1 });
    const bundle = configBundleSchema.parse({
      format: 'cezar-config-bundle', version: 1, exportedAt: 'x', reminders: { workspaceSecretNames: [] },
      projects: [{ name: 'app', remote: REMOTE, config: { defaultRunner: 'codex', plannerModel: 'opus' }, reminders: { secretNames: [] } }],
    });
    const kept = await planConfigBundle(bundle, {}, [b], planEnv);
    expect(kept.preview.sections[0]!.changes).toEqual([
      { key: 'defaultRunner', from: 'claude', to: 'codex', action: 'keep', conflict: true },
      { key: 'plannerModel', to: 'opus', action: 'take', conflict: false },
    ]);
    await applyConfigBundle(kept);
    expect(readJson(join(b.root, '.ai/cezar/config.json'))).toEqual({ defaultRunner: 'claude', keepMe: 1, plannerModel: 'opus' });

    const taken = await planConfigBundle(bundle, { resolutions: { 'project:0:config': { keys: { defaultRunner: 'take' } } } }, [b], planEnv);
    await applyConfigBundle(taken);
    expect(readJson(join(b.root, '.ai/cezar/config.json')).defaultRunner).toBe('codex');
  });

  it('starts a command-bearing section unticked, refuses it when hosted, and leaves unmatched projects alone', async () => {
    process.env.CEZ_HOME = homeB;
    const b = project();
    const other = project('other');
    const bundle = configBundleSchema.parse({
      format: 'cezar-config-bundle', version: 1, exportedAt: 'x', reminders: { workspaceSecretNames: [] },
      projects: [
        { name: 'app', remote: REMOTE, config: { requiredChecks: ['npm test'] }, reminders: { secretNames: [] } },
        { name: 'lost', remote: 'github.com/acme/elsewhere', config: { plannerModel: 'opus' }, reminders: { secretNames: ['TOKEN'] } },
      ],
    });
    const plan = await planConfigBundle(bundle, {}, [b, other], planEnv);
    expect(plan.preview.sections[0]).toMatchObject({ runsCommands: true, selected: false });
    expect(plan.preview.projects[1]).toMatchObject({ match: 'unmatched', reminders: { secretNames: ['TOKEN'] } });
    expect(plan.preview.sections[1]).toMatchObject({ selected: false, issues: [expect.stringMatching(/choose the project/)] });
    expect(plan.ops).toEqual([]);

    const hosted = await planConfigBundle(bundle, { selection: ['project:0:config'] }, [b], { ...planEnv, localHandoff: false });
    expect(hosted.preview.importAllowed).toBe(false);
    expect(hosted.preview.sections[0]!.issues[0]).toMatch(/local cockpit/);

    const mapped = await planConfigBundle(bundle, { mapping: { 1: 'other' } }, [b, other], planEnv);
    expect(mapped.preview.projects[1]).toMatchObject({ match: 'mapped', targetProjectId: 'other' });
    expect(mapped.ops.map((op) => op.sectionId)).toEqual(['project:1:config']);
  });

  it('lets one bundle project land in a target, and asks to re-map the rest', async () => {
    process.env.CEZ_HOME = homeB;
    const b = project();
    const auto = { format: 'cezar-automations', version: 1, exportedAt: 'x', automations: [{ name: 'Nightly', kind: 'schedule', schedule: { type: 'daily', hour: 4 }, task: { prompt: 'x' } }] };
    const bundle = configBundleSchema.parse({
      format: 'cezar-config-bundle', version: 1, exportedAt: 'x', reminders: { workspaceSecretNames: [] },
      projects: [
        { name: 'clone-1', remote: REMOTE, automations: auto, promptTemplates: [{ id: 'one', label: 'One', text: '1' }], reminders: { secretNames: [] } },
        { name: 'clone-2', remote: REMOTE, automations: auto, promptTemplates: [{ id: 'two', label: 'Two', text: '2' }], reminders: { secretNames: [] } },
      ],
    });
    const plan = await planConfigBundle(bundle, {}, [b], planEnv);
    expect(plan.preview.projects.map((p) => p.match)).toEqual(['remote', 'unmatched']);
    expect(plan.preview.sections.find((s) => s.id === 'project:1:automations')!.issues[0]).toMatch(/"clone-1" already lands in that project/);
    await applyConfigBundle(plan);
    expect(AutomationStore.open(join(b.root, '.ai/cezar')).list().map((row) => row.name)).toEqual(['Nightly']);
    expect(readJson(join(b.root, '.ai/cezar/ui-state.json')).promptTemplates.map((t: { id: string }) => t.id)).toEqual(['one']);
    const mappedTwice = await planConfigBundle(bundle, { mapping: { 0: b.id, 1: b.id } }, [b], planEnv);
    expect(mappedTwice.preview.projects[1]!.match).toBe('unmatched');
  });

  it('rolls a replaced automation\'s runtime state back with its definition', async () => {
    process.env.CEZ_HOME = homeB;
    const b = project();
    const store = AutomationStore.open(join(b.root, '.ai/cezar'));
    const existing = store.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4 }, task: { prompt: 'x' } });
    store.setState(existing.id, () => ({ revision: existing.revision, lastRunAt: '2026-11-01T04:00:00.000Z' }));
    const stateBefore = readFileSync(join(b.root, '.ai/cezar/automation-state.json'), 'utf8');
    const bundle = configBundleSchema.parse({
      format: 'cezar-config-bundle', version: 1, exportedAt: 'x', reminders: { workspaceSecretNames: [] }, workspace: { modelsLocked: true },
      projects: [{ name: 'app', remote: REMOTE, reminders: { secretNames: [] },
        automations: { format: 'cezar-automations', version: 1, exportedAt: 'x', automations: [{ name: 'Nightly', kind: 'schedule', schedule: { type: 'daily', hour: 5 }, task: { prompt: 'y' } }] } }],
    });
    const plan = await planConfigBundle(bundle, { resolutions: { 'project:0:automations': { automations: { 0: { action: 'replace' } } } } }, [b], planEnv);
    await expect(applyConfigBundle(plan, { beforeWrite: (id) => { if (id === 'workspace') throw new Error('disk full'); } })).rejects.toMatchObject({ restored: true });
    expect(readFileSync(join(b.root, '.ai/cezar/automation-state.json'), 'utf8')).toBe(stateBefore);
    expect(AutomationStore.open(join(b.root, '.ai/cezar')).get(existing.id)).toMatchObject({ enabled: true, revision: existing.revision });
  });

  it('restores every file already written when a later section fails', async () => {
    process.env.CEZ_HOME = homeB;
    const b = project();
    writeJson(join(homeB, 'config.json'), { systemPrompt: 'Mine' });
    writeJson(join(b.root, '.ai/cezar/config.json'), { plannerModel: 'sonnet' });
    const before = readFileSync(join(b.root, '.ai/cezar/config.json'), 'utf8');
    const bundle = configBundleSchema.parse({
      format: 'cezar-config-bundle', version: 1, exportedAt: 'x', reminders: { workspaceSecretNames: [] },
      workspace: { modelsLocked: true },
      projects: [{ name: 'app', remote: REMOTE, config: { namerModel: 'opus' }, promptTemplates: [{ id: 'n', label: 'New', text: 't' }], reminders: { secretNames: [] } }],
    });
    const plan = await planConfigBundle(bundle, {}, [b], planEnv);
    await expect(applyConfigBundle(plan, { beforeWrite: (id) => { if (id === 'workspace') throw new Error('disk full'); } }))
      .rejects.toMatchObject({ restored: true, message: expect.stringMatching(/disk full; nothing was changed/) });
    expect(readFileSync(join(b.root, '.ai/cezar/config.json'), 'utf8')).toBe(before);
    expect(existsSync(join(b.root, '.ai/cezar/ui-state.json'))).toBe(false);
    expect(readJson(join(homeB, 'config.json'))).toEqual({ systemPrompt: 'Mine' });
  });

  it('rejects a newer bundle version and unknown keys', () => {
    const base = { format: 'cezar-config-bundle', version: 1, exportedAt: 'x', projects: [], reminders: { workspaceSecretNames: [] } };
    expect(configBundleSchema.safeParse({ ...base, version: 3 }).error!.issues[0]!.message).toMatch(/newer cezar \(version 3\)/);
    expect(configBundleSchema.safeParse({ ...base, workspace: { browseRoot: '/x' } }).success).toBe(false);
    expect(configBundleSchema.safeParse({ ...base, secrets: {} }).success).toBe(false);
  });
});

/** Every byte of the secret store's files, so a test can prove none of it reached the bundle. */
function readdirText(dir: string): string {
  if (!existsSync(dir)) return '\u0000never';
  const chunks: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isFile()) chunks.push(readFileSync(path, 'utf8').slice(40, 80));
  }
  return chunks.join('') || '\u0000never';
}
