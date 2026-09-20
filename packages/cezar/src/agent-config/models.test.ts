import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAgentModelDefaults, readAgentModelProvider } from './models.ts';

describe('readAgentModelDefaults', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('reads each agent format and honours project/local precedence', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-native-models-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-native-models-home-'));
    roots.push(repo, home);
    mkdirSync(join(repo, '.claude'), { recursive: true });
    mkdirSync(join(repo, '.codex'), { recursive: true });
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });

    writeFileSync(join(home, '.claude', 'settings.json'), '{"model":"user-claude"}\n');
    writeFileSync(join(repo, '.claude', 'settings.json'), '{"model":"project-claude"}\n');
    writeFileSync(join(repo, '.claude', 'settings.local.json'), '{"model":"local-claude"}\n');
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "user-codex"\n');
    writeFileSync(join(repo, '.codex', 'config.toml'), 'model = "project-codex"\n');
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), '{"model":"openai/user"}\n');
    writeFileSync(join(repo, 'opencode.json'), '{\n  // project wins\n  "model": "openai/project",\n}\n');

    await expect(readAgentModelDefaults(repo, { HOME: home })).resolves.toEqual({
      claude: 'local-claude',
      codex: 'project-codex',
      opencode: 'openai/project',
    });
  });

  it('falls back when a higher-precedence file is missing or malformed', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-native-models-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-native-models-home-'));
    roots.push(repo, home);
    mkdirSync(join(repo, '.claude'), { recursive: true });
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.json'), '{not json');
    writeFileSync(join(home, '.claude', 'settings.json'), '{"model":"user-claude"}');

    await expect(readAgentModelDefaults(repo, { HOME: home })).resolves.toEqual({ claude: 'user-claude' });
  });

  it('reads Claude custom models from settings env and host ANTHROPIC_MODEL', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-native-models-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-native-models-home-'));
    roots.push(repo, home);
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_MODEL: 'deepseek/deepseek-v4-flash' } }),
    );

    await expect(readAgentModelDefaults(repo, { HOME: home })).resolves.toEqual({
      claude: 'deepseek/deepseek-v4-flash',
    });
    await expect(
      readAgentModelDefaults(repo, { HOME: home, ANTHROPIC_MODEL: 'deepseek' }),
    ).resolves.toEqual({ claude: 'deepseek' });
  });

  it('reads Gemini CLI model.name: GEMINI_MODEL, then the project .gemini/settings.json, then the user one (#581)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-native-models-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-native-models-home-'));
    roots.push(repo, home);
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'settings.json'), '{"model":{"name":"gemini-2.5-pro"}}\n');

    await expect(readAgentModelDefaults(repo, { HOME: home })).resolves.toEqual({ gemini: 'gemini-2.5-pro' });

    mkdirSync(join(repo, '.gemini'), { recursive: true });
    writeFileSync(join(repo, '.gemini', 'settings.json'), '{"model":{"name":"gemini-3-flash-preview"}}\n');
    await expect(readAgentModelDefaults(repo, { HOME: home })).resolves.toEqual({ gemini: 'gemini-3-flash-preview' });

    // Environment variables outrank every settings file in Gemini CLI's documented order.
    await expect(
      readAgentModelDefaults(repo, { HOME: home, GEMINI_MODEL: 'gemini-3.5-flash' }),
    ).resolves.toEqual({ gemini: 'gemini-3.5-flash' });

    // GEMINI_CLI_HOME relocates the user file, as it does for the CLI.
    const relocated = mkdtempSync(join(tmpdir(), 'cez-native-models-gemini-home-'));
    roots.push(relocated);
    mkdirSync(join(relocated, '.gemini'), { recursive: true });
    writeFileSync(join(relocated, '.gemini', 'settings.json'), '{"model":{"name":"gemini-3.1-flash-lite"}}\n');
    rmSync(join(repo, '.gemini'), { recursive: true, force: true });
    await expect(
      readAgentModelDefaults(repo, { HOME: home, GEMINI_CLI_HOME: relocated }),
    ).resolves.toEqual({ gemini: 'gemini-3.1-flash-lite' });
  });

  it('pairs a Codex custom provider with its configured model', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-native-models-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-native-models-home-'));
    roots.push(repo, home);
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      'model = "deepseek-chat"\nmodel_provider = "deepseek"\n',
    );

    await expect(readAgentModelDefaults(repo, { HOME: home })).resolves.toEqual({
      codex: 'deepseek/deepseek-chat',
    });
    await expect(readAgentModelProvider('codex', repo, { HOME: home })).resolves.toBe('deepseek');
  });

  it('reads the effective Codex provider even when no native model is pinned', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-native-models-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-native-models-home-'));
    roots.push(repo, home);
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), 'model_provider = "deepseek"\n');

    await expect(readAgentModelDefaults(repo, { HOME: home })).resolves.toEqual({});
    await expect(readAgentModelProvider('codex', repo, { HOME: home })).resolves.toBe('deepseek');
  });
});
