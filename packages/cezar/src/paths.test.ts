import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SERVER_INSTANCE,
  agentHomePaths,
  cezarHomeDir,
  instanceSlug,
  serverInstancesDir,
  serverLockPath,
  serverStatePath,
  workspaceConfigPath,
  workspaceUiStatePath,
} from './paths.ts';

describe('paths', () => {
  const original = process.env.CEZ_HOME;
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
  });

  it('defaults cezarHomeDir to ~/.cezar', () => {
    delete process.env.CEZ_HOME;
    expect(cezarHomeDir()).toBe(join(homedir(), '.cezar'));
  });

  it('honors the CEZ_HOME override', () => {
    process.env.CEZ_HOME = '/tmp/cez-home-test';
    expect(cezarHomeDir()).toBe('/tmp/cez-home-test');
    expect(serverStatePath()).toBe('/tmp/cez-home-test/server.json');
    expect(serverLockPath()).toBe('/tmp/cez-home-test/server.install.lock');
  });

  it('the default instance keeps the legacy un-suffixed paths', () => {
    process.env.CEZ_HOME = '/tmp/cez-home-test';
    expect(serverStatePath(DEFAULT_SERVER_INSTANCE)).toBe('/tmp/cez-home-test/server.json');
    expect(serverLockPath(DEFAULT_SERVER_INSTANCE)).toBe('/tmp/cez-home-test/server.install.lock');
  });

  it('workspace config/ui-state live directly under the cezar home', () => {
    delete process.env.CEZ_HOME;
    expect(workspaceConfigPath()).toBe(join(homedir(), '.cezar', 'config.json'));
    expect(workspaceUiStatePath()).toBe(join(homedir(), '.cezar', 'ui-state.json'));
  });

  it('workspace paths honor the CEZ_HOME override', () => {
    process.env.CEZ_HOME = '/tmp/cez-home-test';
    expect(workspaceConfigPath()).toBe('/tmp/cez-home-test/config.json');
    expect(workspaceUiStatePath()).toBe('/tmp/cez-home-test/ui-state.json');
  });

  it('a named instance lives under server-instances/, keyed by slug', () => {
    process.env.CEZ_HOME = '/tmp/cez-home-test';
    expect(serverInstancesDir()).toBe('/tmp/cez-home-test/server-instances');
    expect(serverStatePath('shop-example-com')).toBe('/tmp/cez-home-test/server-instances/shop-example-com.json');
    expect(serverLockPath('shop-example-com')).toBe(
      '/tmp/cez-home-test/server-instances/shop-example-com.install.lock',
    );
  });
});

describe('instanceSlug', () => {
  it('lowercases and turns every non-alnum run (incl. dots) into a single dash', () => {
    expect(instanceSlug('Shop.Example.COM')).toBe('shop-example-com');
    expect(instanceSlug('a__b--c')).toBe('a-b-c');
    expect(instanceSlug('  lead.trail.  ')).toBe('lead-trail');
  });

  it('degenerate/empty input can never escape the instance namespace', () => {
    expect(instanceSlug('')).toBe(DEFAULT_SERVER_INSTANCE);
    expect(instanceSlug(undefined)).toBe(DEFAULT_SERVER_INSTANCE);
    expect(instanceSlug('.-.-')).toBe(DEFAULT_SERVER_INSTANCE);
  });
});

it('an EMPTY CEZ_HOME falls back to the default instead of a relative cwd path', () => {
  const original = process.env.CEZ_HOME;
  process.env.CEZ_HOME = '';
  try {
    expect(cezarHomeDir().startsWith('/')).toBe(true);
    expect(cezarHomeDir().endsWith('/.cezar')).toBe(true);
  } finally {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
  }
});

describe('agentHomePaths', () => {
  it('defaults to the agents\' documented home directories', () => {
    const paths = agentHomePaths({ HOME: '/home/u' } as NodeJS.ProcessEnv);
    expect(paths.claude).toBe('/home/u/.claude');
    expect(paths.codex).toBe('/home/u/.codex');
    expect(paths.opencodeConfig).toBe('/home/u/.config/opencode');
  });

  it('honors agent-specific home overrides', () => {
    const paths = agentHomePaths({
      HOME: '/home/u',
      CODEX_HOME: '/opt/codex',
      XDG_CONFIG_HOME: '/xdg',
    } as NodeJS.ProcessEnv);
    expect(paths.codex).toBe('/opt/codex');
    expect(paths.opencodeConfig).toBe('/xdg/opencode');
  });

  it('falls back to USERPROFILE when HOME is unset', () => {
    const paths = agentHomePaths({ USERPROFILE: 'C:\\Users\\u' } as unknown as NodeJS.ProcessEnv);
    expect(paths.claude).toContain('.claude');
  });
});
