import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  CONFIG_BUNDLE_FORMAT,
  bundleProjectConfigSchema,
  bundleWorkspaceSchema,
  type AutomationImportRow,
  type BundleChange,
  type BundlePromptTemplate,
  type BundleSectionPlan,
  type BundleSectionResolution,
  type ConfigBundle,
  type ConfigBundlePreview,
  type ConfigBundlePreviewInput,
} from '@open-mercato/cezar-contract';
import { AutomationStore } from '../automations/store.ts';
import { renameWithRetry } from '../fs-rename.ts';
import type { AutomationInputChecks } from '../automations/validate-input.ts';
import type { AutomationDefinition } from '../automations/types.ts';
import { configSchema } from '../config.ts';
import { parseRemote } from '../git-remotes.ts';
import { workspaceConfigPath } from '../paths.ts';
import { readTrackerAssociation } from '../tracker-association.ts';
import { uiStatePath } from '../ui-state.ts';
import { atomicWriteJson, mergeWriteWorkspaceConfig, workspaceConfigSchema } from '../workspace/config.ts';
import { readLifecycleConfigRaw, withLifecycleConfigLock } from '../worktree-lifecycle/config.ts';
import { atomicLifecycleWrite } from '../worktree-lifecycle/store.ts';
import { canonicalJson, digestOf, exportAutomations, planAutomationImport, type AutomationImportPlan } from './automations-file.ts';

/**
 * The configuration bundle (spec 2026-11-04-automations-and-config-export-import, Phase 2): the
 * portable workspace keys, and per project its portable config keys, prompt templates and
 * automations. Secret VALUES, tracker credentials and every machine path stay behind.
 */

export const WORKSPACE_KEYS = Object.keys(bundleWorkspaceSchema.shape) as Array<keyof typeof bundleWorkspaceSchema.shape>;
export const PROJECT_CONFIG_KEYS = Object.keys(bundleProjectConfigSchema.shape) as Array<keyof typeof bundleProjectConfigSchema.shape>;

/** Every workspace key the bundle leaves out, and why — `config-bundle.test.ts` requires a reason for each. */
export const WORKSPACE_EXCLUDED: Record<string, string> = {
  branding: 'names this instance',
  schemaVersion: 'migration cursor of this home',
  browseRoot: 'machine path',
  projectsDir: 'machine path',
  updateChannel: 'per-install update policy',
  cezarId: 'install identity',
  telemetry: 'consent is per machine and never granted by a file',
  lastActiveOn: 'telemetry bookkeeping',
  projects: 'absolute repo paths',
};

export const PROJECT_EXCLUDED: Record<string, string> = {
  worktreeLifecycle: 'local-only hook scripts',
  maxParallel: 'workspace-wide now (resources)',
  memoryLimitMb: 'workspace-wide now (resources)',
  landing: 'auto-landing is a grant made on the machine that pushes',
};

/** `host/owner/repo` — never the URL, which may carry `user:token@`. */
export function normalizeRemote(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const parsed = parseRemote(url);
  return parsed ? `${parsed.host}/${parsed.owner}/${parsed.repo}`.toLowerCase() : undefined;
}

export async function projectRemote(root: string): Promise<string | undefined> {
  const git = (args: string[]) => promisify(execFile)('git', args, { cwd: root, timeout: 5_000 }).then(({ stdout }) => stdout.trim());
  try {
    const names = (await git(['remote'])).split('\n').filter(Boolean);
    const name = names.includes('origin') ? 'origin' : names[0];
    return name ? normalizeRemote(await git(['remote', 'get-url', name])) : undefined;
  } catch {
    return undefined;
  }
}

/** What `JSON.parse` can produce. */
type Json = unknown;

async function readJsonObject(path: string): Promise<Record<string, Json>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, Json>) : {};
  } catch {
    return {};
  }
}

/** Every leaf of `input` survives the owning schema unchanged — a `.catch()` that swallowed it does not. */
function survives(parsed: unknown, input: unknown): boolean {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return Object.entries(input as Record<string, unknown>).every(([key, value]) => survives((parsed as Record<string, unknown>)[key], value));
  }
  return canonicalJson(parsed) === canonicalJson(input);
}

function validWorkspaceValue(key: string, value: unknown): boolean {
  const parsed = workspaceConfigSchema.safeParse({ [key]: value });
  return parsed.success && survives((parsed.data as Record<string, unknown>)[key], value);
}

function validProjectValue(key: string, value: unknown): boolean {
  const parsed = configSchema.safeParse({ [key]: value });
  return parsed.success && survives((parsed.data as Record<string, unknown>)[key], value);
}

/**
 * A skills repo as a file may carry it: `owner/name`, or a URL with its credentials stripped. A
 * local path only means something on this machine, and a URL may embed `user:token@`.
 */
export function portableSkillsRepo(repo: string): string | undefined {
  const value = repo.trim();
  if (/^file:/i.test(value) || /^[/~.\\]/.test(value) || /^[A-Za-z]:[\\/]/.test(value)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      // ssh's `git@` names the account the key logs in as; any password, or an https user, is a credential.
      if (url.password || !/^(ssh|git\+ssh)$/i.test(url.protocol.replace(/:$/, ''))) { url.username = ''; url.password = ''; }
      return url.toString();
    } catch { return undefined; }
  }
  return value;
}

function portableRepoList(value: Json): Json {
  if (!Array.isArray(value)) return value;
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || typeof (entry as { repo?: unknown }).repo !== 'string') return [];
    const repo = portableSkillsRepo((entry as { repo: string }).repo);
    return repo ? [{ ...(entry as Record<string, unknown>), repo }] : [];
  });
}

const REPO_LIST_KEYS = new Set(['skillsRepos', 'orgSkillsRepos']);

/** The keys an export carries: portable repo lists, then the allowlist and owning-schema checks. */
function exportable<K extends string>(raw: Record<string, Json>, keys: readonly K[], valid: (key: string, value: unknown) => boolean) {
  const portableRaw = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, REPO_LIST_KEYS.has(key) ? portableRepoList(value) : value]));
  return pick(portableRaw, keys, valid);
}

/** The keys a raw file actually sets, filtered to the allowlist and to values its schema accepts. */
function pick<K extends string>(raw: Record<string, Json>, keys: readonly K[], valid: (key: string, value: unknown) => boolean): Partial<Record<K, Json>> {
  const out: Partial<Record<K, Json>> = {};
  for (const key of keys) if (raw[key] !== undefined && valid(key, raw[key])) out[key] = raw[key];
  return out;
}

export interface BundleProjectSource {
  id: string;
  name: string;
  root: string;
}

export interface BundleEnv {
  automations: boolean;
  /** Secret NAMES of a scope — never values. */
  secretNames: (scope: { kind: 'workspace' } | { kind: 'project'; projectId: string; root: string }) => Promise<string[]>;
  remoteOf?: (root: string) => Promise<string | undefined>;
}

const dataDirOf = (root: string) => join(root, '.ai', 'cezar');

async function promptTemplatesOf(root: string): Promise<BundlePromptTemplate[] | undefined> {
  const templates = (await readJsonObject(uiStatePath(root))).promptTemplates;
  if (!Array.isArray(templates)) return undefined;
  return templates.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { id, label, text, skills } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || typeof label !== 'string' || typeof text !== 'string') return [];
    return [{ id, label, text, ...(Array.isArray(skills) ? { skills: skills.filter((s): s is string => typeof s === 'string') } : {}) }];
  });
}

export async function buildConfigBundle(
  projects: BundleProjectSource[],
  env: BundleEnv,
  options: { now?: Date; cezarVersion?: string } = {},
): Promise<ConfigBundle> {
  const now = options.now ?? new Date();
  const remoteOf = env.remoteOf ?? projectRemote;
  const workspace = exportable(await readJsonObject(workspaceConfigPath()), WORKSPACE_KEYS, validWorkspaceValue);
  const bundleProjects = [];
  for (const project of projects) {
    const config = exportable(await readJsonObject(join(dataDirOf(project.root), 'config.json')), PROJECT_CONFIG_KEYS, validProjectValue);
    const promptTemplates = await promptTemplatesOf(project.root);
    const remote = await remoteOf(project.root);
    const tracker = (await readTrackerAssociation(dataDirOf(project.root)).catch(() => null))?.kind;
    bundleProjects.push({
      name: project.name,
      ...(remote ? { remote } : {}),
      ...(Object.keys(config).length ? { config } : {}),
      ...(promptTemplates ? { promptTemplates } : {}),
      ...(env.automations
        ? { automations: exportAutomations(AutomationStore.open(dataDirOf(project.root)).list(), { now, cezarVersion: options.cezarVersion }) }
        : {}),
      reminders: {
        secretNames: await env.secretNames({ kind: 'project', projectId: project.id, root: project.root }),
        ...(tracker ? { tracker } : {}),
      },
    });
  }
  return {
    format: CONFIG_BUNDLE_FORMAT,
    version: 1,
    exportedAt: now.toISOString(),
    ...(options.cezarVersion ? { cezarVersion: options.cezarVersion } : {}),
    ...(Object.keys(workspace).length ? { workspace } : {}),
    projects: bundleProjects,
    reminders: { workspaceSecretNames: await env.secretNames({ kind: 'workspace' }) },
  };
}

// ---- planning ----------------------------------------------------------------------------------

export interface BundleTargetProject extends BundleProjectSource {
  remote?: string;
}

export interface BundlePlanEnv {
  automations: boolean;
  localHandoff: boolean;
  checksFor: (project: BundleTargetProject) => AutomationInputChecks;
}

interface ConfigOp { kind: 'config'; project: BundleTargetProject; set: Record<string, unknown> }
interface TemplatesOp { kind: 'promptTemplates'; project: BundleTargetProject; templates: BundlePromptTemplate[] }
interface AutomationsOp { kind: 'automations'; project: BundleTargetProject; plan: AutomationImportPlan }
interface WorkspaceOp { kind: 'workspace'; set: Record<string, unknown> }
type BundleOp = (ConfigOp | TemplatesOp | AutomationsOp | WorkspaceOp) & { sectionId: string };

export interface BundlePlan {
  preview: ConfigBundlePreview;
  ops: BundleOp[];
}

function keyChanges(
  incoming: Record<string, Json | undefined>,
  current: Record<string, Json>,
  resolution: BundleSectionResolution | undefined,
  valid: (key: string, value: unknown) => boolean,
): { changes: BundleChange[]; set: Record<string, unknown>; issues: string[] } {
  const changes: BundleChange[] = [];
  const set: Record<string, Json> = {};
  const issues: string[] = [];
  for (const [key, to] of Object.entries(incoming)) {
    if (to === undefined) continue;
    const from = current[key];
    if (from !== undefined && canonicalJson(from) === canonicalJson(to)) continue;
    if (!valid(key, to)) issues.push(`${key}: not a valid value on this cezar`);
    const conflict = from !== undefined;
    const action = conflict ? (resolution?.keys?.[key] ?? 'keep') : 'take';
    changes.push({ key, ...(conflict ? { from } : {}), to, action, conflict });
    if (action === 'take') set[key] = to;
  }
  return { changes, set, issues };
}

/**
 * Pure apart from file reads and the injected checks. The digest covers the bundle, every choice,
 * and the current value of everything a selected section would touch, so apply can refuse a
 * preview the target has moved past.
 */
export async function planConfigBundle(
  bundle: ConfigBundle,
  input: Omit<ConfigBundlePreviewInput, 'bundle'>,
  registered: BundleTargetProject[],
  env: BundlePlanEnv,
): Promise<BundlePlan> {
  const sections: BundleSectionPlan[] = [];
  const ops: BundleOp[] = [];
  const fingerprint: unknown[] = [];
  const explicit = input.selection ? new Set(input.selection) : undefined;
  const choose = (id: string, applicable: boolean, runsCommands: boolean) =>
    explicit ? explicit.has(id) : applicable && !runsCommands;

  if (bundle.workspace) {
    const current = pick(await readJsonObject(workspaceConfigPath()), WORKSPACE_KEYS, () => true);
    const { changes, set, issues } = keyChanges(bundle.workspace, current, input.resolutions?.workspace, validWorkspaceValue);
    const selected = choose('workspace', true, false);
    fingerprint.push(['workspace', current]);
    sections.push({ id: 'workspace', kind: 'workspace', selected, changes, runsCommands: false, issues });
    if (selected && Object.keys(set).length) ops.push({ sectionId: 'workspace', kind: 'workspace', set });
  }

  const projects: ConfigBundlePreview['projects'] = [];
  // Each section is planned against the target's current state, so two bundle projects landing
  // in one target would plan over each other: the first claim wins, the rest must be re-mapped.
  const claimed = new Map<string, string>();
  for (const [index, source] of bundle.projects.entries()) {
    const mapped = input.mapping?.[String(index)];
    let target: BundleTargetProject | undefined;
    let match: ConfigBundlePreview['projects'][number]['match'];
    if (mapped === null) match = 'skipped';
    else if (mapped !== undefined) {
      target = registered.find((project) => project.id === mapped);
      match = target ? 'mapped' : 'unmatched';
    } else {
      const byRemote = source.remote ? registered.filter((project) => project.remote === source.remote) : [];
      target = byRemote.length === 1 ? byRemote[0] : undefined;
      match = target ? 'remote' : 'unmatched';
    }
    let taken: string | undefined;
    if (target && claimed.has(target.id)) {
      taken = claimed.get(target.id);
      target = undefined;
      match = 'unmatched';
    } else if (target) claimed.set(target.id, source.name);
    projects.push({
      index,
      name: source.name,
      ...(source.remote ? { remote: source.remote } : {}),
      ...(target ? { targetProjectId: target.id } : {}),
      match,
      reminders: source.reminders,
    });
    const unmatched = target ? [] : [
      match === 'skipped' ? 'this project is skipped'
        : taken !== undefined ? `"${taken}" already lands in that project — map this one elsewhere or skip it`
        : 'choose the project this section lands in',
    ];
    const base = (id: string, kind: BundleSectionPlan['kind']) => ({
      id, kind, projectIndex: index, ...(target ? { targetProjectId: target.id } : {}),
    });

    if (source.config) {
      const id = `project:${index}:config`;
      const current = target ? await readJsonObject(join(dataDirOf(target.root), 'config.json')) : {};
      const { changes, set, issues } = keyChanges(source.config, current, input.resolutions?.[id], validProjectValue);
      const runsCommands = source.config.requiredChecks !== undefined;
      const selected = choose(id, !!target, runsCommands);
      if (target) fingerprint.push([id, target.id, pick(current, PROJECT_CONFIG_KEYS, () => true)]);
      if (runsCommands && !env.localHandoff) issues.push('requiredChecks runs shell commands — import it from a local cockpit');
      sections.push({ ...base(id, 'config'), selected, changes, runsCommands, issues: [...unmatched, ...issues] });
      if (selected && target && Object.keys(set).length) ops.push({ sectionId: id, kind: 'config', project: target, set });
    }

    if (source.promptTemplates) {
      const id = `project:${index}:promptTemplates`;
      const current = target ? (await promptTemplatesOf(target.root)) ?? [] : [];
      const resolution = input.resolutions?.[id];
      const changes: BundleChange[] = [];
      const merged = [...current];
      for (const template of source.promptTemplates) {
        const at = merged.findIndex((existing) => existing.id === template.id);
        if (at >= 0 && canonicalJson(merged[at]) === canonicalJson(template)) continue;
        const conflict = at >= 0;
        const action = conflict ? (resolution?.keys?.[template.id] ?? 'keep') : 'take';
        changes.push({ key: template.id, ...(conflict ? { from: merged[at] } : {}), to: template, action, conflict });
        if (action === 'take') {
          if (conflict) merged[at] = template;
          else merged.push(template);
        }
      }
      const issues = merged.length > 50 ? ['more than 50 prompt templates after the merge'] : [];
      const selected = choose(id, !!target, false);
      if (target) fingerprint.push([id, target.id, current]);
      sections.push({ ...base(id, 'promptTemplates'), selected, changes, runsCommands: false, issues: [...unmatched, ...issues] });
      if (selected && target && changes.some((change) => change.action === 'take')) ops.push({ sectionId: id, kind: 'promptTemplates', project: target, templates: merged });
    }

    if (source.automations) {
      const id = `project:${index}:automations`;
      const issues = [...unmatched];
      let rows: AutomationImportRow[] = [];
      let plan: AutomationImportPlan | undefined;
      if (!env.automations) issues.push('automations are off on this cockpit');
      else {
        const existing = target ? AutomationStore.open(dataDirOf(target.root)).list() : [];
        plan = await planAutomationImport(source.automations, input.resolutions?.[id]?.automations, existing,
          { localHandoff: env.localHandoff, checks: target ? env.checksFor(target) : { trackerTriggerIssue: async () => null, accountIssue: async () => null } });
        rows = plan.rows;
        if (target) fingerprint.push([id, target.id, plan.planDigest]);
        const blocked = rows.filter((row) => row.action !== 'skip' && row.issues.length).length;
        if (blocked) issues.push(`${blocked} automation${blocked === 1 ? ' needs' : 's need'} attention`);
      }
      const runsCommands = rows.some((row) => row.runsCommands);
      const selected = choose(id, !!target && env.automations, runsCommands);
      sections.push({ ...base(id, 'automations'), selected, changes: [], automations: rows, runsCommands, issues });
      if (selected && target && plan && (plan.creates.length || plan.replaces.length)) ops.push({ sectionId: id, kind: 'automations', project: target, plan });
    }
  }

  const planDigest = digestOf({ bundle, input, localHandoff: env.localHandoff, fingerprint });
  return {
    preview: { sections, projects, reminders: bundle.reminders, importAllowed: env.localHandoff, planDigest },
    ops,
  };
}

// ---- apply -------------------------------------------------------------------------------------

/** A file's bytes before the import touched it; `null` = it did not exist. */
interface PreImage { path: string; content: string | null }

async function capture(path: string): Promise<PreImage> {
  try { return { path, content: await readFile(path, 'utf8') }; }
  catch { return { path, content: null }; }
}

async function restore(image: PreImage): Promise<void> {
  if (image.content === null) return rm(image.path, { force: true });
  const temporary = `${image.path}.restore.tmp`;
  await writeFile(temporary, image.content, { mode: 0o600 });
  await renameWithRetry(temporary, image.path);
}

async function writeProjectConfig(root: string, set: Record<string, unknown>): Promise<void> {
  const path = join(dataDirOf(root), 'config.json');
  // The same lock and atomic writer `PUT /config` uses, so a concurrent settings save cannot interleave.
  await withLifecycleConfigLock(root, async () => {
    const raw = await readLifecycleConfigRaw(root);
    await atomicLifecycleWrite(path, { ...raw, ...set });
  });
}

export class BundleApplyError extends Error {
  constructor(message: string, readonly restored: boolean, readonly leftChanged: string[]) { super(message); }
}

export interface ApplyHooks {
  /** Test seam: runs before each section's write. */
  beforeWrite?: (sectionId: string) => void | Promise<void>;
  /** Every automation a section created or replaced, for the caller's change events. */
  onAutomations?: (projectId: string, definitions: AutomationDefinition[]) => void;
}

/**
 * Project sections first, the workspace last. Every file is captured before the first write; a
 * failure restores what was already written and names anything it could not put back.
 */
export async function applyConfigBundle(plan: BundlePlan, hooks: ApplyHooks = {}): Promise<string[]> {
  const ordered = [...plan.ops.filter((op) => op.kind !== 'workspace'), ...plan.ops.filter((op) => op.kind === 'workspace')];
  const images: PreImage[] = [];
  for (const op of ordered) {
    if (op.kind === 'config') images.push(await capture(join(dataDirOf(op.project.root), 'config.json')));
    else if (op.kind === 'promptTemplates') images.push(await capture(uiStatePath(op.project.root)));
    else if (op.kind === 'automations') {
      // importMany resets a replaced row's runtime state, so the state file rolls back with it.
      images.push(await capture(join(dataDirOf(op.project.root), 'automations.json')));
      images.push(await capture(join(dataDirOf(op.project.root), 'automation-state.json')));
    }
    else images.push(await capture(workspaceConfigPath()));
  }
  const applied: string[] = [];
  /** How many pre-images belong to ops that started writing — the ones a failure must restore. */
  const imagesOf = (op: BundleOp) => (op.kind === 'automations' ? 2 : 1);
  let written = 0;
  try {
    for (const op of ordered) {
      await hooks.beforeWrite?.(op.sectionId);
      if (op.kind === 'config') await writeProjectConfig(op.project.root, op.set);
      else if (op.kind === 'promptTemplates') {
        const state = await readJsonObject(uiStatePath(op.project.root));
        await atomicWriteJson(uiStatePath(op.project.root), { ...state, promptTemplates: op.templates });
      } else if (op.kind === 'automations') {
        const result = AutomationStore.open(dataDirOf(op.project.root)).importMany({ creates: op.plan.creates, replaces: op.plan.replaces });
        hooks.onAutomations?.(op.project.id, [...result.created, ...result.replaced]);
      } else {
        await mergeWriteWorkspaceConfig((config) => { Object.assign(config, op.set); });
      }
      written += imagesOf(op);
      applied.push(op.sectionId);
    }
    return applied;
  } catch (error) {
    const leftChanged: string[] = [];
    const failed = ordered[applied.length];
    for (const image of images.slice(0, written + (failed ? imagesOf(failed) : 0)).reverse()) {
      try { await restore(image); } catch { leftChanged.push(image.path); }
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new BundleApplyError(
      leftChanged.length ? `${message}; these files could not be restored: ${leftChanged.join(', ')}` : `${message}; nothing was changed`,
      leftChanged.length === 0,
      leftChanged,
    );
  }
}
