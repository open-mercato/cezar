import { describe, expect, it } from 'vitest';
import {
  aiGatewayApplyManifestSchema,
  aiGatewayCommand,
  aiGatewaySchema,
  aiGatewaySecretName,
  aiGatewaySecretNameIssue,
  classifyPersistedGateway,
  createAiGatewaySchema,
  normalizeAiGatewayBaseUrl,
  preferredGatewayProtocol,
  resolveAiGatewaySelection,
  updateAiGatewaySchema,
} from '@open-mercato/cezar-contract';

const auth = {
  protocols: { 'openai-responses': 'bearer' as const },
  catalog: 'bearer' as const,
};

const createBody = {
  name: 'Sandbox',
  baseUrl: 'https://gateway.example/v1',
  protocols: ['openai-responses' as const],
  auth,
};

describe('AI gateway contract', () => {
  it('accepts a strict create and rejects unknown fields, a trailing slash, and an enable without a key', () => {
    expect(normalizeAiGatewayBaseUrl(' https://gateway.example/v1/ ')).toBe('https://gateway.example/v1');
    expect(normalizeAiGatewayBaseUrl('https://gateway.example/v1///')).toBe('https://gateway.example/v1');
    expect(createAiGatewaySchema.parse(createBody)).not.toHaveProperty('enabled');
    expect(createAiGatewaySchema.safeParse({ ...createBody, kind: 'openrouter' }).success).toBe(false);
    expect(createAiGatewaySchema.safeParse({ ...createBody, baseUrl: 'https://gateway.example/v1/' }).success).toBe(false);
    expect(createAiGatewaySchema.safeParse({ ...createBody, baseUrl: 'https://user:secret@gateway.example/v1' }).success).toBe(false);
    expect(createAiGatewaySchema.safeParse({ ...createBody, baseUrl: 'https://gateway.example/v1?x=1' }).success).toBe(false);
    expect(createAiGatewaySchema.safeParse({ ...createBody, enabled: true }).success).toBe(false);
    expect(createAiGatewaySchema.safeParse({ ...createBody, enabled: true, apiKey: 'sk-test' }).success).toBe(true);
  });

  it('does not trim an API key and does not treat a blank key as deletion', () => {
    expect(createAiGatewaySchema.parse({ ...createBody, apiKey: '  sk-test' }).apiKey).toBe('  sk-test');
    expect(createAiGatewaySchema.safeParse({ ...createBody, apiKey: '' }).success).toBe(false);
    expect(createAiGatewaySchema.safeParse({ ...createBody, apiKey: 'line\nbreak' }).success).toBe(false);
    expect(updateAiGatewaySchema.safeParse({}).success).toBe(true);
    expect(updateAiGatewaySchema.safeParse({ provisioningKey: 'sandbox' }).success).toBe(false);
    expect(updateAiGatewaySchema.safeParse({ pendingWrite: false }).success).toBe(false);
  });

  it('requires auth for every selected protocol and no others', () => {
    expect(createAiGatewaySchema.safeParse({
      ...createBody,
      protocols: ['openai-responses', 'anthropic-messages'],
    }).success).toBe(false);
    expect(createAiGatewaySchema.safeParse({
      ...createBody,
      auth: {
        protocols: { 'openai-responses': 'bearer', 'anthropic-messages': 'x-api-key' },
        catalog: 'bearer',
      },
    }).success).toBe(false);
  });

  it('rejects a duplicated provisioning key and an unknown manifest field', () => {
    const entry = { key: 'sandbox', name: 'Sandbox', baseUrl: 'https://gateway.example/v1', protocols: ['openai-responses'], auth };
    expect(aiGatewayApplyManifestSchema.safeParse({ version: 1, gateways: [entry, { key: 'sandbox' }] }).success).toBe(false);
    expect(aiGatewayApplyManifestSchema.safeParse({ version: 1, gateways: [{ ...entry, apiKeyEnv: 'KEY' }] }).success).toBe(false);
    expect(aiGatewayApplyManifestSchema.safeParse({ version: 1, gateways: [] }).success).toBe(false);
    expect(aiGatewayApplyManifestSchema.parse({ version: 1, gateways: [entry] }).gateways).toHaveLength(1);
  });

  it('fails closed on a bad provisioning key or pending marker and drops a non-gateway', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const gateway = {
      id,
      name: 'Sandbox',
      baseUrl: 'https://gateway.example/v1',
      protocols: ['openai-responses'],
      auth,
      enabled: false,
      routingRevision: 'rev-1',
    };
    expect(classifyPersistedGateway(gateway)).toMatchObject({ kind: 'gateway' });
    expect(classifyPersistedGateway({ ...gateway, provisioningKey: 'Sandbox' })).toEqual({ kind: 'invalid', id });
    expect(classifyPersistedGateway({ ...gateway, pendingWrite: 'true' })).toEqual({ kind: 'invalid', id });
    expect(classifyPersistedGateway({ note: 'not a gateway' })).toEqual({ kind: 'drop' });
    expect(aiGatewaySchema.parse({ ...gateway, pendingWrite: true }).pendingWrite).toBe(true);
  });

  it('pins runner protocols and spells handoffs as ai-gateways', () => {
    expect(preferredGatewayProtocol('claude', ['openai-completions', 'anthropic-messages'])).toBe('anthropic-messages');
    expect(preferredGatewayProtocol('codex', ['openai-completions', 'openai-responses'])).toBe('openai-responses');
    expect(preferredGatewayProtocol('cursor', ['openai-completions'])).toBeNull();
    expect(preferredGatewayProtocol('pi', ['anthropic-messages', 'openai-completions'])).toBe('openai-completions');
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(aiGatewayCommand(id, 'claude', 'anthropic/claude', 'claude -p task')).toBe(
      `cez ai-gateways exec ${id} claude --model anthropic/claude -- -p task`,
    );
    expect(aiGatewayCommand(id, 'cursor', 'gpt', 'agent')).toBeNull();
    expect(aiGatewayCommand(id, 'claude', 'bad model', 'claude')).toBeNull();
    expect(aiGatewaySecretNameIssue(id)).toBeNull();
    expect(aiGatewaySecretName(id)).toBe('LLM_PROVIDER_550E8400_E29B_41D4_A716_446655440000');
  });

  it('resolves explicit choice, then the runner default, and never a substitute', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const gateway = {
      id,
      enabled: true,
      hasApiKey: true,
      protocols: ['openai-responses' as const, 'anthropic-messages' as const],
      routingRevision: 'rev',
    };
    const gateways = [gateway];
    expect(resolveAiGatewaySelection({ runner: 'claude', defaults: undefined, gateways }).status).toBe('native');
    expect(resolveAiGatewaySelection({ runner: 'claude', explicit: 'native', defaults: { claude: id }, gateways })).toEqual({ status: 'native' });
    expect(resolveAiGatewaySelection({ runner: 'claude-cli', defaults: { claude: id }, gateways })).toEqual({
      status: 'gateway', gatewayId: id, protocol: 'anthropic-messages', routingRevision: 'rev',
    });
    expect(resolveAiGatewaySelection({ runner: 'codex', defaults: { codex: id }, gateways })).toMatchObject({ protocol: 'openai-responses' });
    expect(resolveAiGatewaySelection({ runner: 'cursor', defaults: { cursor: id }, gateways }).status).toBe('unavailable');
    expect(resolveAiGatewaySelection({ runner: 'claude', defaults: { claude: id }, gateways: [{ ...gateway, enabled: false }] })).toMatchObject({
      status: 'unavailable', message: 'This gateway is off.',
    });
    expect(resolveAiGatewaySelection({ runner: 'claude', defaults: { claude: id }, gateways: [{ ...gateway, pendingWrite: true }] }).status).toBe('unavailable');
    expect(resolveAiGatewaySelection({ runner: 'pi', explicit: id, defaults: undefined, gateways: [] })).toMatchObject({ status: 'unavailable' });
    expect(resolveAiGatewaySelection({ runner: 'claude', defaults: { claude: 'not-a-choice' }, gateways }).status).toBe('unavailable');
  });
});
