import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CodexToolPolicyError } from './codex-tool-policy.ts';
import type { RestrictedCodexHome } from './codex-restricted-home.ts';

import { CODEX_DISABLED_FEATURES } from './codex-restricted-policy.ts';
const object = z.record(z.string(), z.unknown());
const configResponse = z.object({
  config: object,
  layers: z.array(z.object({ name: z.object({ type: z.string(), file: z.string().optional() }).passthrough(), config: object, disabledReason: z.string().nullish() }).passthrough()),
});
const emptyList = z.object({ data: z.array(z.unknown()).length(0), nextCursor: z.null().optional() });
const hooksResponse = z.object({ data: z.array(z.object({ hooks: z.array(z.unknown()).length(0), errors: z.array(z.unknown()).length(0), warnings: z.array(z.string()).length(0) })).min(1) });
function fail(detail: string): never { throw new CodexToolPolicyError(detail); }

/** The oldest protocol the isolation was verified against; 0.169.0 predates the feature listing. */
export const CODEX_VERIFIED_MIN: readonly [number, number, number] = [0, 169, 0];

/**
 * A version floor, not an exact pin (#2330 pinned 0.169.0 and every Codex release broke restricted
 * steps). A newer Codex is held by `codexFeaturesToDisable`/`verifyRestrictedCodexFeatures` instead.
 * Returns whether the version is the static-list baseline that needs no feature listing.
 */
export function verifyRestrictedCodexIdentity(value: unknown, home: RestrictedCodexHome): { baseline: boolean } {
  const identity = z.object({ userAgent: z.string(), codexHome: z.string(), platformOs: z.enum(['macos', 'linux']) }).safeParse(value);
  // SemVer: `-prerelease` and `+build` are the only suffixes; anything else is not a version we know.
  const version = identity.success ? /^cezar\/(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?(?=\s|$)/.exec(identity.data.userAgent) : null;
  const parts = version ? [Number(version[1]), Number(version[2]), Number(version[3])] : undefined;
  const order = parts ? (parts[0]! - CODEX_VERIFIED_MIN[0]) || (parts[1]! - CODEX_VERIFIED_MIN[1]) || (parts[2]! - CODEX_VERIFIED_MIN[2]) : -1;
  // A 0.169.0 prerelease predates the verified build and its feature listing, so it ranks below it.
  if (!identity.success || order < 0 || (order === 0 && version![4])) fail(`the installed Codex protocol has not been verified (needs Codex ${CODEX_VERIFIED_MIN.join('.')} or newer)`);
  if (resolve(identity.data.codexHome) !== home.path) fail('Codex did not use the isolated account home');
  // Only the exact 0.169.0 build is the static-list baseline; a `+build` of it or anything newer is checked live.
  return { baseline: order === 0 && !version![5] };
}

const featureList = z.object({
  data: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+$/), stage: z.string(), enabled: z.boolean() }).passthrough()),
  nextCursor: z.string().nullish(),
});
export type CodexFeature = z.infer<typeof featureList>['data'][number];

/** One `experimentalFeature/list` page; anything unparseable refuses the step. */
export function parseCodexFeaturePage(value: unknown): { data: CodexFeature[]; nextCursor?: string | null } {
  const parsed = featureList.safeParse(value);
  if (!parsed.success) fail('Codex cannot report its native features');
  return parsed.data;
}

// A `removed` flag is kept only so old configs parse; it controls nothing and cannot be toggled.
// `unified_exec` only picks the exec backend and stays on whatever we set (0.170.0); with
// `shell_tool` off and `environments: []` on every turn it has no shell and nowhere to run.
const TOLERATED = new Set(['unified_exec']);
const controllable = (feature: CodexFeature) => feature.stage !== 'removed' && !TOLERATED.has(feature.name);

/** Every native feature that is on gets turned off: an unknown one may be a tool this isolation never heard of. */
export function codexFeaturesToDisable(features: readonly CodexFeature[]): string[] {
  return features.filter(feature => feature.enabled && controllable(feature)).map(feature => feature.name);
}

export function verifyRestrictedCodexFeatures(features: readonly CodexFeature[]): void {
  if (!features.length) fail('Codex cannot report its native features');
  const on = features.filter(feature => feature.enabled && (controllable(feature) || (CODEX_DISABLED_FEATURES as readonly string[]).includes(feature.name)));
  if (on.length) fail(`native Codex features stayed enabled (${on.map(feature => feature.name).slice(0, 5).join(', ')})`);
}

export function verifyRestrictedCodexConfig(value: unknown, home: RestrictedCodexHome): void {
  const parsed = configResponse.safeParse(value);
  if (!parsed.success) fail('Codex cannot report its effective configuration and layers');
  const { config, layers } = parsed.data;
  if (config.approval_policy !== 'never' || config.sandbox_mode !== 'read-only' || config.web_search !== 'disabled') fail('the sandbox or approval policy differs from the restricted profile');
  const features = object.safeParse(config.features);
  if (!features.success || CODEX_DISABLED_FEATURES.some(key => features.data[key] !== false)) fail('a required native tool/extension control is unavailable');
  for (const key of ['mcp_servers', 'plugins']) {
    const map = object.safeParse(config[key]);
    if (!map.success || Object.keys(map.data).length) fail(`native ${key} are present`);
  }
  for (const key of ['hooks', 'apps', 'browser_use', 'computer_use', 'notify']) if (config[key] != null) fail(`native ${key} are present`);
  if (!layers.some(layer => layer.name.type === 'user' && layer.name.file === `${home.path}/config.toml`)) fail('the isolated config layer is missing');
  for (const layer of layers) {
    if (layer.name.type === 'user' && layer.name.file === `${home.path}/config.toml`) {
      if (!isDeepStrictEqual(layer.config, JSON.parse(JSON.stringify(home.config)))) fail('the isolated configuration changed before startup');
      continue;
    }
    if (layer.name.type === 'project' && layer.disabledReason) continue;
    if (layer.name.type === 'system' && Object.keys(layer.config).length === 0) continue;
    // A ChatGPT workspace pushes its model policy as a layer; a model choice grants no tool.
    if (layer.name.type === 'enterpriseManaged' && Object.keys(layer.config).every(key => MANAGED_MODEL_KEYS.has(key))) continue;
    // A managed setting can load rules, services or hooks before a turn. It is not inherited.
    fail(`an unverified ${layer.name.type} configuration layer is active`);
  }
}

const MANAGED_MODEL_KEYS = new Set(['model', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity']);

// Workspace requirements that only narrow: which logins work, and features forced OFF.
const NARROWING_REQUIREMENTS: Readonly<Record<string, z.ZodType>> = {
  allowedLoginMethods: z.array(z.string()),
  featureRequirements: z.record(z.string(), z.literal(false)),
};

export function verifyRestrictedCodexRequirements(value: unknown): void {
  const parsed = z.object({ requirements: z.record(z.string(), z.unknown()).nullable() }).safeParse(value);
  if (!parsed.success) fail('system or managed requirements could not be proven absent');
  for (const [key, requirement] of Object.entries(parsed.data.requirements ?? {})) {
    if (requirement === null) continue;
    if (!NARROWING_REQUIREMENTS[key]?.safeParse(requirement).success) fail(`a managed Codex requirement (${key}) could not be verified`);
  }
}

export function verifyRestrictedCodexServices(hooks: unknown, mcp: unknown): void {
  if (!hooksResponse.safeParse(hooks).success || !emptyList.safeParse(mcp).success) fail('hooks or MCP services could not be proven absent');
}

export function verifyRestrictedCodexThread(value: unknown, cwd: string): void {
  const thread = z.object({ approvalPolicy: z.literal('never'), cwd: z.string(), sandbox: z.object({ type: z.literal('readOnly'), networkAccess: z.literal(false) }) }).safeParse(value);
  if (!thread.success || resolve(thread.data.cwd) !== resolve(cwd)) fail('the thread did not retain its sandbox and approval policy');
}
