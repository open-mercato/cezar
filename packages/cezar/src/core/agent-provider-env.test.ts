import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateRunName } from '../runs/auto-name.ts';
import { OmpRpcRunner } from './omp-rpc-runner.ts';
import { kimiSubscriptionModel } from './kimi-model-catalog.ts';
import { geminiAllowsProviderKey } from './gemini-credentials.ts';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildChildEnv } from './agent-env.ts';
import { agentProviderEnv, verifyProviderLogin } from './agent-provider-env.ts';
import { createRunner } from './runner-factory.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { codexThreadOverrides } from './codex-app-server-runner.ts';
import type { AgentSession } from './agent-runner.ts';
import { readAgentProviderKey, readAgentProviders } from '../workspace/agent-providers.ts';

vi.mock('../workspace/agent-providers.ts', () => ({
  readAgentProviders: vi.fn(), readAgentProviderKey: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

const model = 'vendor/model';
const method = { kind: 'custom' as const, addedAt: '', baseUrl: 'https://gateway.example', keyHint: '…3210',
  models: { fetchedAt: '', ids: [{ id: model }] } };
const key = 'fixture value 543210';

describe('provider launch selection', () => {
  it('leaves an absent installation on its native authentication, including host keys', async () => {
    vi.mocked(readAgentProviders).mockResolvedValue({ agents: {} });
    expect(await agentProviderEnv('claude')).toBeUndefined();
    expect(readAgentProviderKey).not.toHaveBeenCalled();
  });

  it.each(['0', '1'])('removes conflicting host and extra env spellings on subscription, full=%s', async full => {
    vi.mocked(readAgentProviders).mockResolvedValue({ agents: { claude: { active: 'subscription', methods: {} } } });
    const provider = await agentProviderEnv('claude');
    const env = buildChildEnv({ backend: 'claude', provider, source: { CEZ_AGENT_ENV_FULL: full,
      CEZ_ENV_PASSTHROUGH: 'ANTHROPIC_API_KEY', Anthropic_Api_Key: 'host', ANTHROPIC_BASE_URL: 'host',
      ANTHROPIC_AUTH_TOKEN: 'host', CLAUDE_CODE_USE_BEDROCK: '1', HOME: 'home' },
      extraEnv: { ANTHROPIC_API_KEY: 'extra', CLAUDE_CONFIG_DIR: 'profile' } });
    expect(Object.keys(env).join(' ')).not.toMatch(/anthropic_(api_key|base_url|auth_token)|use_bedrock/i);
    expect(env).toMatchObject({ HOME: 'home', CLAUDE_CONFIG_DIR: 'profile' });
    expect(readAgentProviderKey).not.toHaveBeenCalled();
  });

  it('enforces the active method at start and replays the saved one with the matching endpoint snapshot', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    vi.mocked(readAgentProviders).mockResolvedValue({ agents: { codex: { active: 'subscription', methods: { custom: method } } } });
    vi.mocked(readAgentProviderKey).mockResolvedValue(key);
    await expect(agentProviderEnv('codex', { requested: 'custom' })).rejects.toThrow(/active method/i);
    const provider = await agentProviderEnv('codex', { saved: 'custom', model });
    expect(readAgentProviderKey).toHaveBeenCalledWith('codex', 'custom', method);
    const rpc = codexThreadOverrides({ cwd: '/fixture', model: provider?.model, provider }, { 'mcp_servers.fixture': {} });
    expect(rpc).toMatchObject({ model, config: { model_provider: 'cezar', 'mcp_servers.fixture': {} } });
    expect(JSON.stringify(rpc)).not.toContain(key);
    expect(Object.values(buildChildEnv({ backend: 'codex', source: {}, provider }))).toContain(key);
  });

  it('keeps a removed managed method from being replaced by a host key of the same name', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'other-host-key');
    vi.mocked(readAgentProviders).mockResolvedValue({ agents: { pi: { methods: {} } } });
    await expect(agentProviderEnv('pi', { saved: 'openrouter', model })).rejects.toThrow(/provider was removed/);
    expect(readAgentProviderKey).not.toHaveBeenCalled();
  });

  it('selects an any-mode gateway by catalog, requires a tag for duplicates and reads no dry-run key', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const entry = { methods: { custom: method, openrouter: { ...method, kind: 'openrouter' as const } } };
    vi.mocked(readAgentProviders).mockResolvedValue({ agents: { pi: entry } });
    await expect(agentProviderEnv('pi', { model })).rejects.toThrow(/several providers/i);
    const explicit = await agentProviderEnv('pi', { requested: 'custom', model });
    expect(explicit?.model).toMatch(/\/vendor\/model$/);
    expect(explicit?.catalogModel).toBe(model);
    vi.mocked(readAgentProviders).mockResolvedValue({ agents: { pi: { methods: { custom: method } } } });
    expect((await agentProviderEnv('pi', { model }))?.methodId).toBe('custom');
    expect(readAgentProviderKey).not.toHaveBeenCalled();
  });

  it('keeps the OS keychain error actionable without forwarding unsafe exception text', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    vi.mocked(readAgentProviders).mockResolvedValue({ agents: { claude: { active: 'custom', methods: { custom: method } } } });
    vi.mocked(readAgentProviderKey).mockRejectedValue(new Error(key));
    await expect(agentProviderEnv('claude')).rejects.toThrow(/unlock the OS keychain/i);
    vi.mocked(readAgentProviderKey).mockResolvedValue(undefined);
    await expect(agentProviderEnv('claude')).rejects.toThrow(/no key/i);
  });

  it('scrubs the key from streamed fragments, tool output, CLI errors and one-shot results', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    vi.stubEnv('CEZ_REDACT_SECRETS', '0');
    vi.mocked(readAgentProviders).mockResolvedValue({ agents: { claude: { active: 'custom', methods: { custom: method } } } });
    vi.mocked(readAgentProviderKey).mockResolvedValue(key);
    const start = vi.spyOn(ClaudeCliRunner.prototype, 'startSession').mockImplementation((spec, onEvent, opts) => {
      expect(spec.provider?.methodId).toBe('custom');
      onEvent?.({ type: 'tool-result', toolCallId: 'fixture', result: key, isError: true });
      for (const delta of [key.slice(0, 6), key.slice(6)]) opts?.onUiEvent?.({ type: 'item.delta', field: 'text', itemId: 'item', delta });
      return { result: Promise.resolve({ text: key, toolCalls: [], tokensUsed: 0 }), open: true, sendMessage: () => false, end() {}, interrupt() {} } satisfies AgentSession;
    });
    const runner = createRunner('claude');
    const events = vi.fn();
    const ui = vi.fn();
    const spec = { cwd: tmpdir(), userPrompt: 'fixture' };
    const provider = await agentProviderEnv('claude');
    await runner.startSession({ ...spec, provider }, events, { onUiEvent: ui }).result;
    expect(ui.mock.calls.map(([event]) => event.delta).join('')).toBe('[REDACTED]');
    expect(events.mock.calls[0]?.[0].result).toBe('[REDACTED]');
    expect((await runner.run(spec)).text).toBe('[REDACTED]');
    start.mockImplementation(() => { throw new Error('CLI: ' + key); });
    await expect(runner.run(spec)).rejects.toThrow('CLI: [REDACTED]');
  });
});

it('probes Claude in the selected account environment and refuses a competing stored API-key helper', async () => {
  vi.stubEnv('CEZ_DRY_RUN', '0');
  vi.stubEnv('CEZ_AGENT_ENV_FULL', '1');
  vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-conflict');
  const home = mkdtempSync(join(tmpdir(), 'cez-fake-auth-cli-'));
  try {
    const executable = join(home, 'fake-cli');
    writeFileSync(executable, [
      '#!/usr/bin/env node',
      "const loggedIn = process.argv.slice(2).join(' ') === 'auth status --json' && !process.env.ANTHROPIC_API_KEY;",
      "console.log(JSON.stringify({ loggedIn, authMethod: process.env.CLAUDE_CONFIG_DIR === 'fixture-account' ? 'claude.ai' : 'api_key_helper' }));",
    ].join('\n'), { mode: 0o700 });
    vi.stubEnv('CEZ_CLAUDE_BIN', executable);
    vi.mocked(readAgentProviders).mockResolvedValue({ agents: { claude: { active: 'subscription', methods: {} } } });
    const provider = await agentProviderEnv('claude');
    await expect(verifyProviderLogin('claude', provider, home, { CLAUDE_CONFIG_DIR: 'fixture-account' })).resolves.toBeUndefined();
    await expect(verifyProviderLogin('claude', provider, home, { CLAUDE_CONFIG_DIR: 'different' })).rejects.toThrow(/selected subscription/);
    expect(readAgentProviderKey).not.toHaveBeenCalled();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it('respects the model lock and requires either a catalog match or an offered cheap bookkeeping model', async () => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  const entry = { ...method, models: { fetchedAt: '', ids: [{ id: model }, { id: 'vendor/fast-mini' }] } };
  vi.mocked(readAgentProviders).mockResolvedValue({ agents: {
    pi: { methods: { custom: entry } }, claude: { active: 'custom', methods: { custom: entry } },
  } });
  await expect(agentProviderEnv('pi', { model, modelsLocked: true })).rejects.toThrow(/unlock agent models/i);
  expect((await agentProviderEnv('claude', { model, modelsLocked: true }))?.model).toBeUndefined();
  await expect(agentProviderEnv('claude', { model: 'missing' })).rejects.toThrow(/does not offer/);
  expect((await agentProviderEnv('claude', { model: 'haiku', preferCheapModel: true }))?.model).toBe('vendor/fast-mini');
});

it('requires compatible Gemini auth across user, workspace and system settings', () => {
  const home = mkdtempSync(join(tmpdir(), 'cez-gemini-auth-'));
  try {
    const cwd = join(home, 'repo');
    const system = join(home, 'system.json');
    const defaults = join(home, 'defaults.json');
    const env = { GEMINI_CLI_HOME: home, GEMINI_CLI_SYSTEM_SETTINGS_PATH: system, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: defaults };
    for (const root of [cwd, home]) mkdirSync(join(root, '.gemini'), { recursive: true });
    writeFileSync(join(cwd, '.gemini', 'settings.json'), '{"security":{"auth":{"selectedType":"gemini-api-key"}}}');
    expect(geminiAllowsProviderKey(cwd, env)).toBe(true);
    for (const file of [system, defaults, join(home, '.gemini/settings.json'), join(cwd, '.gemini/settings.json')]) {
      writeFileSync(file, '{"security":{"auth":{"enforcedType":"vertex-ai"}}}');
      expect(geminiAllowsProviderKey(cwd, env)).toBe(false);
      writeFileSync(file, '{invalid');
      expect(geminiAllowsProviderKey(cwd, env)).toBe(false);
      rmSync(file);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it('merges the selected OpenCode provider with the inline permissions and MCP settings of this launch', async () => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.mocked(readAgentProviders).mockResolvedValue({ agents: { opencode: { methods: { custom: method } } } });
  const provider = await agentProviderEnv('opencode', { requested: 'custom', model });
  const source = { CEZ_AGENT_ENV_FULL: '1', OPENCODE_CONFIG_CONTENT: JSON.stringify({
    permission: { bash: 'ask' }, mcp: { fixture: { enabled: false } }, provider: { another: {} },
  }) };
  const env = buildChildEnv({ backend: 'opencode', provider, source });
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
  expect(config).toMatchObject({ permission: { bash: 'ask' }, mcp: { fixture: { enabled: false } }, provider: { another: {} } });
  expect(config.model).toBe(provider?.model);
  expect(JSON.stringify(config)).not.toContain('cezar-dry-run-provider-key');
});

it('verifies the actual Kimi subscription alias against the vendor-managed endpoints', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cez-kimi-subscription-'));
  try {
    for (const [origin, expected] of [['https://api.kimi.ai/coding/v1/', true], ['https://api.kimi.com/coding/v1', true], ['https://example.test', false]] as const) {
      writeFileSync(join(home, 'config.toml'), [
        '[providers."managed:kimi-code"]', 'type="kimi"', 'api_key=""', 'base_url=' + JSON.stringify(origin),
        '[models."kimi-code/k3"]', 'provider="managed:kimi-code"', '[models."saved/key"]', 'provider="other"',
      ].join('\n'));
      expect(await kimiSubscriptionModel({ KIMI_CODE_HOME: home }, 'kimi-code/k3')).toBe(expected);
      expect(await kimiSubscriptionModel({ KIMI_CODE_HOME: home }, 'saved/key')).toBe(false);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it.each([true, false])('gates both opening and queued OMP prompts on the in-process OAuth proof, ack=%s', async acknowledge => {
  const cwd = mkdtempSync(join(tmpdir(), 'cez-omp-proof-'));
  try {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    const bin = join(cwd, 'fake-omp');
    const log = join(cwd, 'commands');
    writeFileSync(bin, [
      '#!/usr/bin/env node', "const fs = require('node:fs');",
      "require('node:readline').createInterface({ input: process.stdin }).on('line', line => {",
      "  const cmd = JSON.parse(line); fs.appendFileSync('commands', cmd.type + '\\n');",
      "  if (cmd.type === 'get_state') setTimeout(() => {",
      "    if (process.env.FIXTURE_ACK === '1') process.stderr.write('cezar-omp-oauth:' + process.env.OMP_CEZAR_OAUTH_CHECK + '\\n');",
      "    else { process.stderr.write('cezar-omp-oauth:unrelated\\n'); process.exit(0); }",
      "  }, 30);",
      "  if (cmd.message === 'queued') process.exit(0);",
      "});",
    ].join('\n'), { mode: 0o700 });
    vi.mocked(readAgentProviders).mockResolvedValue({ agents: { omp: { methods: {} } } });
    const model = 'anthropic/fixture-model';
    const provider = await agentProviderEnv('omp', { requested: 'anthropic', model });
    const session = new OmpRpcRunner({ bin }).startSession({ cwd, provider, model, userPrompt: 'opening', timeoutMs: 3000,
      env: { FIXTURE_ACK: acknowledge ? '1' : '0' } });
    session.sendMessage([{ type: 'text', text: 'queued' }]);
    if (acknowledge) await session.result;
    else await expect(session.result).rejects.toThrow(/could not confirm the selected subscription/);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(acknowledge ? ['get_state', 'prompt', 'prompt'] : ['get_state']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

it('names a task on its saved gateway and substitutes an offered cheap model for the native namer alias', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cez-provider-name-'));
  try {
    for (const name of ['CEZ_HOME', 'HOME', 'CLAUDE_CONFIG_DIR']) vi.stubEnv(name, cwd);
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const fast = 'team/small-mini';
    vi.mocked(readAgentProviders).mockResolvedValue({ agents: { claude: {
      active: 'subscription', methods: { custom: { ...method, models: { fetchedAt: '', ids: [{ id: fast }] } } },
    } } });
    const start = vi.spyOn(ClaudeCliRunner.prototype, 'startSession').mockImplementation(() => ({
      open: true, end() {}, interrupt() {}, sendMessage: () => false,
      result: Promise.resolve({ text: '{"title":"naming the task"}', toolCalls: [], tokensUsed: 0 }),
    }));
    const answer = await generateRunName(cwd, { task: 'name this', providerSelection: { runner: 'claude', method: { saved: 'custom' } } }, { runner: 'claude', env: {} });
    expect(answer?.titleSummary).toBe('naming the task');
    expect(start.mock.calls[0]?.[0]).toMatchObject({ model: fast, provider: { methodId: 'custom' } });
    expect(readAgentProviderKey).not.toHaveBeenCalled();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

it('keeps an untagged native Pi pin on its subscription even when the gateway serves that ID', async () => {
  const native = 'anthropic/claude-sonnet-4-5';
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.mocked(readAgentProviders).mockResolvedValue({ agents: { pi: { methods: {
    custom: { ...method, models: { fetchedAt: '', ids: [{ id: native }] } },
  } } } });
  expect((await agentProviderEnv('pi', { model: native }))?.methodId).toBe('anthropic');
  expect((await agentProviderEnv('pi', { model: native, requested: 'custom' }))?.methodId).toBe('custom');
});

it('delegates new launches to native auth under the environment lock and refuses a pinned provider', async () => {
  vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '1');
  vi.mocked(readAgentProviders).mockResolvedValue({ agents: { claude: { active: 'custom', methods: { custom: method } } } });
  expect(await agentProviderEnv('claude')).toBeUndefined();
  await expect(agentProviderEnv('claude', { saved: 'custom' })).rejects.toThrow(/native/);
  expect(readAgentProviders).not.toHaveBeenCalled();
  const start = vi.spyOn(ClaudeCliRunner.prototype, 'startSession').mockImplementation(() => ({
    result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }), open: false, end() {}, interrupt() {}, sendMessage: () => false,
  }));
  await createRunner('claude').run({ cwd: tmpdir(), userPrompt: 'fixture', model: 'opus', reasoningEffort: 'high' });
  expect(start.mock.calls[0]?.[0].model).toBeUndefined();
  expect(start.mock.calls[0]?.[0].reasoningEffort).toBeUndefined();
});

it('can launch a model from the last successful gateway discovery', async () => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.mocked(readAgentProviders).mockResolvedValue({ agents: { claude: { active: 'custom', methods: {
    custom: { ...method, models: { ...method.models, error: 'offline' } },
  } } } });
  expect((await agentProviderEnv('claude', { model }))?.catalogModel).toBe(model);
});
