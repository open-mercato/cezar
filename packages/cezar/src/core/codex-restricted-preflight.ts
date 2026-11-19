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

/** Refuse changed/unknown transports; this is a tested protocol contract, not a version lower bound. */
export function verifyRestrictedCodexIdentity(value: unknown, home: RestrictedCodexHome): void {
  const identity = z.object({ userAgent: z.string(), codexHome: z.string(), platformOs: z.enum(['macos', 'linux']) }).safeParse(value);
  if (!identity.success || !/^cezar\/0\.169\.0(?:\s|$)/.test(identity.data.userAgent)) fail('the installed Codex protocol has not been verified');
  if (resolve(identity.data.codexHome) !== home.path) fail('Codex did not use the isolated account home');
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
    // A managed setting can load rules, services or hooks before a turn. It is not inherited.
    fail(`an unverified ${layer.name.type} configuration layer is active`);
  }
}

export function verifyRestrictedCodexRequirements(value: unknown): void {
  if (!z.object({ requirements: z.null() }).safeParse(value).success) fail('system or managed requirements could not be proven absent');
}

export function verifyRestrictedCodexServices(hooks: unknown, mcp: unknown): void {
  if (!hooksResponse.safeParse(hooks).success || !emptyList.safeParse(mcp).success) fail('hooks or MCP services could not be proven absent');
}

export function verifyRestrictedCodexThread(value: unknown, cwd: string): void {
  const thread = z.object({ approvalPolicy: z.literal('never'), cwd: z.string(), sandbox: z.object({ type: z.literal('readOnly'), networkAccess: z.literal(false) }) }).safeParse(value);
  if (!thread.success || resolve(thread.data.cwd) !== resolve(cwd)) fail('the thread did not retain its sandbox and approval policy');
}
