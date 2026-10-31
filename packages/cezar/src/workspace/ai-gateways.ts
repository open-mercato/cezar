import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  AI_GATEWAY_MAX_RECORDS,
  aiGatewaySchema,
  aiGatewaySecretName,
  aiGatewaysResponseSchema,
  classifyPersistedGateway,
  createAiGatewaySchema,
  normalizeAiGatewayBaseUrl,
  normalizeAiGatewayName,
  updateAiGatewaySchema,
  type AiGateway,
  type AiGatewayAuth,
  type AiGatewayProtocol,
  type AiGatewayView,
  type AiGatewaysResponse,
  type CreateAiGateway,
  type UpdateAiGateway,
} from '@open-mercato/cezar-contract';
import { cezarHomeDir } from '../paths.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig, type WorkspaceConfig } from './config.ts';
import { FILE_LOCK_TIMEOUT_MS, withFileLock } from './file-lock.ts';
import { SecretStore } from './secrets.ts';

const WORKSPACE = { kind: 'workspace' } as const;

export class AiGatewayError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_input' | 'not_found' | 'capacity' | 'unavailable' = 'invalid_input',
  ) {
    super(message);
    this.name = 'AiGatewayError';
  }
}

function isRow(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function rowsOf(config: WorkspaceConfig): Record<string, unknown>[] | 'invalid' {
  if (config.aiGateways === undefined) return [];
  if (!Array.isArray(config.aiGateways)) return 'invalid';
  return config.aiGateways.filter(isRow);
}

const FORMER_OPENROUTER_DEFAULT_PROTOCOLS = ['anthropic-messages', 'openai-completions', 'openai-responses'] as const;

/** The unshipped default row, not a gateway the operator saved. Any edit or stored key keeps the row. */
function isUntouchedOpenRouterDefault(gateway: AiGateway): boolean {
  if (gateway.pendingWrite || gateway.enabled) return false;
  if (gateway.provisioningKey !== 'openrouter') return false;
  if (gateway.name !== 'OpenRouter' || gateway.baseUrl !== 'https://openrouter.ai/api/v1') return false;
  const protocols = [...gateway.protocols].sort();
  if (protocols.length !== FORMER_OPENROUTER_DEFAULT_PROTOCOLS.length) return false;
  if (protocols.some((protocol, index) => protocol !== FORMER_OPENROUTER_DEFAULT_PROTOCOLS[index])) return false;
  if (gateway.auth.catalog !== 'bearer') return false;
  return FORMER_OPENROUTER_DEFAULT_PROTOCOLS.every((protocol) => gateway.auth.protocols[protocol] === 'bearer');
}

function invalidInput(prefix: string): AiGatewayError {
  return new AiGatewayError(prefix, 'invalid_input');
}

function normalizeBody(input: unknown): unknown {
  if (!isRow(input)) return input;
  return {
    ...input,
    ...(typeof input.name === 'string' ? { name: normalizeAiGatewayName(input.name) } : {}),
    ...(typeof input.baseUrl === 'string' ? { baseUrl: normalizeAiGatewayBaseUrl(input.baseUrl) } : {}),
  };
}

export function aiGatewayRoutingRevision(parts: {
  baseUrl: string;
  protocols: readonly AiGatewayProtocol[];
  auth: AiGatewayAuth;
}): string {
  const protocols = [...parts.protocols].sort();
  const authKeys = Object.keys(parts.auth.protocols).sort();
  const body = JSON.stringify({
    baseUrl: parts.baseUrl,
    protocols,
    auth: {
      catalog: parts.auth.catalog,
      protocols: Object.fromEntries(authKeys.map((key) => [key, parts.auth.protocols[key as AiGatewayProtocol]])),
    },
  });
  return createHash('sha256').update(body).digest('hex').slice(0, 32);
}

function toView(gateway: AiGateway, hasApiKey: boolean): AiGatewayView {
  return {
    id: gateway.id,
    ...(gateway.provisioningKey ? { provisioningKey: gateway.provisioningKey } : {}),
    ...(gateway.pendingWrite ? { pendingWrite: true } : {}),
    name: gateway.name,
    baseUrl: gateway.baseUrl,
    protocols: [...gateway.protocols].sort(),
    auth: gateway.auth,
    enabled: gateway.enabled,
    routingRevision: gateway.routingRevision,
    hasApiKey,
  };
}

function sameRecord(left: AiGateway, right: AiGateway): boolean {
  return left.name === right.name
    && left.baseUrl === right.baseUrl
    && left.enabled === right.enabled
    && left.routingRevision === right.routingRevision
    && left.provisioningKey === right.provisioningKey
    && left.pendingWrite === right.pendingWrite
    && JSON.stringify([...left.protocols].sort()) === JSON.stringify([...right.protocols].sort())
    && JSON.stringify(left.auth) === JSON.stringify(right.auth);
}

/**
 * Workspace AI gateways. Secrets stay in the vault under `LLM_PROVIDER_<UUID>`.
 * A changed key is pending in both config copies before the vault write, and ready only
 * after the final metadata commit. A failed vault write leaves the row pending.
 */
export class AiGateways {
  constructor(
    private readonly secrets = new SecretStore(),
    private readonly lockTimeoutMs = FILE_LOCK_TIMEOUT_MS,
  ) {}

  async list(): Promise<AiGatewaysResponse> {
    return this.exclusive(async () => {
      await this.removeUntouchedOpenRouterDefaults();
      return this.read();
    });
  }

  async create(input: unknown): Promise<AiGatewayView> {
    return this.exclusive(() => this.createUnlocked(input));
  }

  async update(id: string, input: unknown): Promise<AiGatewayView> {
    return this.exclusive(() => this.updateUnlocked(id, input));
  }

  async remove(id: string): Promise<void> {
    return this.exclusive(() => this.removeUnlocked(id));
  }

  /** `null` clears the runner's choice back to native. Does not read or write `agentDefaults`. */
  async setDefault(runner: string, choice: 'native' | string | null): Promise<void> {
    return this.exclusive(() => this.setDefaultUnlocked(runner, choice));
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    return withFileLock(join(cezarHomeDir(), 'ai-gateways.lock'), action, this.lockTimeoutMs);
  }

  private async createUnlocked(input: unknown): Promise<AiGatewayView> {
    const parsed = createAiGatewaySchema.safeParse(normalizeBody(input));
    if (!parsed.success) throw invalidInput('Gateway settings are invalid. Check the name, API base URL, protocols and key.');
    await this.removeUntouchedOpenRouterDefaults();
    const record = this.newRecord(parsed.data);
    if (parsed.data.apiKey === undefined) {
      await this.rewriteRows((rows) => {
        if (rows.length >= AI_GATEWAY_MAX_RECORDS) throw new AiGatewayError(`At most ${AI_GATEWAY_MAX_RECORDS} AI gateways can be saved.`, 'capacity');
        return [...rows, record];
      }, false);
      return toView(record, false);
    }
    const pending = { ...record, pendingWrite: true as const };
    await this.commitSecret(aiGatewaySecretName(record.id), parsed.data.apiKey, (rows) => {
      if (rows.length >= AI_GATEWAY_MAX_RECORDS) throw new AiGatewayError(`At most ${AI_GATEWAY_MAX_RECORDS} AI gateways can be saved.`, 'capacity');
      return [...rows, pending];
    }, (rows) => rows.map((row) => row.id === record.id ? record : row));
    return toView(record, true);
  }

  private async updateUnlocked(id: string, input: unknown): Promise<AiGatewayView> {
    if (!zUuid(id)) throw new AiGatewayError('That AI gateway was not found.', 'not_found');
    const parsed = updateAiGatewaySchema.safeParse(normalizeBody(input));
    if (!parsed.success) throw invalidInput('Gateway settings are invalid. Check the name, API base URL, protocols and key.');
    const current = await this.requireGateway(id);
    const next = this.merge(current, parsed.data);
    const secret = aiGatewaySecretName(id);
    const keyChanges = await this.keyChanges(secret, parsed.data.apiKey);
    if (next.enabled && !keyChanges.readable && parsed.data.apiKey === undefined) {
      throw invalidInput('An enabled gateway needs an API key.');
    }
    if (current.pendingWrite && parsed.data.apiKey === undefined) {
      throw new AiGatewayError('Update interrupted — save the API key again or remove this gateway.', 'unavailable');
    }
    if (!current.pendingWrite && !keyChanges.write) {
      if (sameRecord(current, next)) return toView(current, keyChanges.readable);
      await this.rewriteRows((rows) => this.replaceRow(rows, id, next), false);
      return toView(next, keyChanges.readable);
    }
    const apiKey = parsed.data.apiKey;
    if (apiKey === undefined) throw new AiGatewayError('Update interrupted — save the API key again or remove this gateway.', 'unavailable');
    const cleared = { ...next };
    delete cleared.pendingWrite;
    await this.commitSecret(secret, apiKey, (rows) => rows.map((row) => row.id === id ? { ...row, pendingWrite: true } : row), (rows) => this.replaceRow(rows, id, cleared));
    return toView(cleared, true);
  }

  private async setDefaultUnlocked(runner: string, choice: 'native' | string | null): Promise<void> {
    const key = runner === 'claude-cli' ? 'claude' : runner;
    if (!['claude', 'codex', 'opencode', 'cursor', 'pi', 'junie', 'copilot'].includes(key)) {
      throw invalidInput('That agent does not exist.');
    }
    if (choice !== null && choice !== 'native' && !zUuid(choice)) throw invalidInput('Choose Native or a saved gateway.');
    await mergeWriteWorkspaceConfig((config) => {
      const current = config.aiGatewayDefaults;
      if (current !== undefined && (typeof current !== 'object' || current === null || Array.isArray(current))) {
        throw new AiGatewayError('The saved defaults could not be read.', 'unavailable');
      }
      const defaults = { ...(current as Record<string, unknown> | undefined) };
      if (choice === null) delete defaults[key];
      else defaults[key] = choice;
      config.aiGatewayDefaults = defaults;
    });
  }

  private async removeUnlocked(id: string): Promise<void> {
    if (!zUuid(id)) throw new AiGatewayError('That AI gateway was not found.', 'not_found');
    let removed = false;
    await mergeWriteWorkspaceConfig((config) => {
      const rows = rowsOf(config);
      if (rows === 'invalid') throw new AiGatewayError('AI gateway settings could not be read.', 'unavailable');
      const next = rows.filter((row) => row.id !== id);
      if (next.length === rows.length) throw new AiGatewayError('That AI gateway was not found.', 'not_found');
      config.aiGateways = next;
      removed = true;
    });
    if (removed) await this.secrets.unset(WORKSPACE, aiGatewaySecretName(id));
  }

  private replaceRow(rows: Record<string, unknown>[], id: string, next: AiGateway): Record<string, unknown>[] {
    const index = rows.findIndex((row) => row.id === id);
    const previous = index < 0 ? undefined : rows[index];
    if (!previous) throw new AiGatewayError('That AI gateway was removed.', 'not_found');
    const stored = [...rows];
    const written: Record<string, unknown> = { ...previous, ...next };
    delete written.pendingWrite;
    stored[index] = written;
    return stored;
  }

  /** Pending marker in both config copies, then the vault, then the ready record. A failed vault leaves the marker. */
  private async commitSecret(
    secret: string,
    apiKey: string,
    markPending: (rows: Record<string, unknown>[]) => Record<string, unknown>[],
    commit: (rows: Record<string, unknown>[]) => Record<string, unknown>[],
  ): Promise<void> {
    await this.rewriteRows(markPending, true);
    try {
      await this.secrets.set(WORKSPACE, secret, apiKey, ['cezar']);
    } catch {
      throw new AiGatewayError('The API key could not be saved. Save it again or remove this gateway.', 'unavailable');
    }
    try {
      await this.rewriteRows(commit, true);
    } catch (error) {
      if (error instanceof AiGatewayError) throw error;
      throw new AiGatewayError('The API key could not be saved. Save it again or remove this gateway.', 'unavailable');
    }
  }

  private async rewriteRows(
    mutate: (rows: Record<string, unknown>[]) => Record<string, unknown>[],
    requireBackup: boolean,
  ): Promise<void> {
    let snapshot: WorkspaceConfig | undefined;
    try {
      await mergeWriteWorkspaceConfig((config) => {
        snapshot = structuredClone(config);
        const rows = rowsOf(config);
        if (rows === 'invalid') throw new AiGatewayError('AI gateway settings could not be read.', 'unavailable');
        config.aiGateways = mutate(rows);
      }, { requireBackup });
    } catch (error) {
      if (requireBackup && snapshot && !(error instanceof AiGatewayError)) {
        const restore = snapshot;
        await mergeWriteWorkspaceConfig(() => restore).catch(() => {});
      }
      throw error;
    }
  }

  /** Drop only the former keyless OpenRouter default. Skip the write when secrets cannot be read. */
  private async removeUntouchedOpenRouterDefaults(): Promise<void> {
    const config = await loadWorkspaceConfig();
    const rows = rowsOf(config);
    if (rows === 'invalid' || rows.length === 0) return;
    const listed = await this.secrets.list(WORKSPACE);
    if (listed.skipped) return;
    const names = new Set(listed.secrets.map((entry) => entry.name));
    const drop = new Set<string>();
    for (const row of rows) {
      const classified = classifyPersistedGateway(row);
      if (classified.kind !== 'gateway' || !isUntouchedOpenRouterDefault(classified.gateway)) continue;
      if (names.has(aiGatewaySecretName(classified.gateway.id))) continue;
      drop.add(classified.gateway.id);
    }
    if (drop.size === 0) return;
    await mergeWriteWorkspaceConfig((current) => {
      const currentRows = rowsOf(current);
      if (currentRows === 'invalid') return;
      current.aiGateways = currentRows.filter((row) => typeof row.id !== 'string' || !drop.has(row.id));
    });
  }

  private newRecord(input: CreateAiGateway): AiGateway {
    const protocols = [...input.protocols].sort();
    const enabled = input.enabled ?? false;
    return {
      id: randomUUID(),
      name: input.name,
      baseUrl: input.baseUrl,
      protocols,
      auth: input.auth,
      enabled,
      routingRevision: aiGatewayRoutingRevision({ baseUrl: input.baseUrl, protocols, auth: input.auth }),
    };
  }

  private merge(current: AiGateway, patch: UpdateAiGateway): AiGateway {
    const protocols = [...(patch.protocols ?? current.protocols)].sort();
    const auth = patch.auth ?? current.auth;
    const baseUrl = patch.baseUrl ?? current.baseUrl;
    const next = {
      ...current,
      name: patch.name ?? current.name,
      baseUrl,
      protocols,
      auth,
      enabled: patch.enabled ?? current.enabled,
      routingRevision: aiGatewayRoutingRevision({ baseUrl, protocols, auth }),
    };
    const parsed = aiGatewaySchema.safeParse(next);
    if (!parsed.success) throw invalidInput('Gateway settings are invalid. Check the name, API base URL, protocols and key.');
    return parsed.data;
  }

  private async keyChanges(secret: string, apiKey: string | undefined): Promise<{ readable: boolean; write: boolean; previous?: string }> {
    const resolved = await this.secrets.resolve(undefined, 'cezar', [secret]);
    const previous = resolved.values[secret];
    if (apiKey === undefined) return { readable: previous !== undefined, write: false, previous };
    if (previous === apiKey) return { readable: true, write: false, previous };
    return { readable: true, write: true, previous };
  }

  private async requireGateway(id: string): Promise<AiGateway> {
    const config = await loadWorkspaceConfig();
    const rows = rowsOf(config);
    if (rows === 'invalid') throw new AiGatewayError('AI gateway settings could not be read.', 'unavailable');
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new AiGatewayError('That AI gateway was not found.', 'not_found');
    const classified = classifyPersistedGateway(row);
    if (classified.kind !== 'gateway') throw new AiGatewayError('This gateway record is unreadable. Remove it and add it again.', 'unavailable');
    return classified.gateway;
  }

  private async read(): Promise<AiGatewaysResponse> {
    const [config, listed, keyBackend] = await Promise.all([
      loadWorkspaceConfig(),
      this.secrets.list(WORKSPACE),
      this.secrets.keyBackend(),
    ]);
    const rows = rowsOf(config);
    if (rows === 'invalid') {
      return aiGatewaysResponseSchema.parse({
        gateways: [],
        unavailable: [],
        keyBackend,
        registryError: 'AI gateway settings could not be read.',
      });
    }
    const names = new Set(listed.skipped ? [] : listed.secrets.map((entry) => entry.name));
    const gateways: AiGatewayView[] = [];
    const unavailable: { id: string }[] = [];
    for (const row of rows) {
      const classified = classifyPersistedGateway(row);
      if (classified.kind === 'gateway') gateways.push(toView(classified.gateway, names.has(aiGatewaySecretName(classified.gateway.id))));
      else if (classified.kind === 'invalid') unavailable.push({ id: classified.id });
    }
    return aiGatewaysResponseSchema.parse({
      gateways,
      unavailable,
      keyBackend,
      ...(listed.skipped ? { secretsSkipped: listed.skipped } : {}),
    });
  }
}

function zUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
