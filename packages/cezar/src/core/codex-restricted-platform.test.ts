// Runs on every OS: platform and path module are injected, so no POSIX-only fixture is needed (#2368, #2146).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { prepareRestrictedCodexHome, type RestrictedCodexHome } from './codex-restricted-home.ts';
import { LINUX_PLATFORM, WINDOWS_PLATFORM, samePath, type RestrictedPlatform } from './codex-restricted-platform.ts';
import { CODEX_READ_PREFIXES, compileCodexRestrictedPolicy } from './codex-restricted-policy.ts';
import { verifyRestrictedCodexConfig, verifyRestrictedCodexIdentity, verifyRestrictedCodexThread } from './codex-restricted-preflight.ts';
import { CodexReadBroker } from './codex-restricted-tools.ts';
import { CODEX_DISABLED_FEATURES } from './codex-restricted-policy.ts';

const WIN_HOME = 'C:\\Users\\dev\\.cezar\\codex-restricted\\abc123';
const WIN_CWD = 'C:\\work\\repo';
const POSIX_HOME = '/home/dev/.cezar/codex-restricted/abc123';

function fixture(platform: RestrictedPlatform) {
  const win = platform.os === 'win32';
  const path = win ? WIN_HOME : POSIX_HOME;
  const config = { approval_policy: 'never', sandbox_mode: 'read-only', web_search: 'disabled', features: Object.fromEntries(CODEX_DISABLED_FEATURES.map(k => [k, false])) };
  const home: RestrictedCodexHome = { path, env: {}, config, toolEnv: {}, githubReadsAllowed: true };
  const file = win ? `${path}\\config.toml` : `${path}/config.toml`;
  return {
    home, cwd: win ? WIN_CWD : '/work/repo', configFile: file,
    identity: { userAgent: 'cezar/0.169.0 (codex)', codexHome: path, platformOs: win ? 'windows' : 'linux' },
    configRead: { config: { ...config, mcp_servers: {}, plugins: {} }, layers: [{ name: { type: 'user', file }, config }] },
    thread: (cwd: string, sandbox: unknown = { type: 'readOnly', networkAccess: false }) => ({ approvalPolicy: 'never', cwd, sandbox }),
  };
}

describe.each([['windows', WINDOWS_PLATFORM], ['linux', LINUX_PLATFORM]] as const)('restricted Codex preflight on injected %s', (_name, platform) => {
  it('accepts a verified start and resume', () => {
    const f = fixture(platform);
    expect(() => verifyRestrictedCodexIdentity(f.identity, f.home, platform)).not.toThrow();
    expect(() => verifyRestrictedCodexConfig(f.configRead, f.home, platform)).not.toThrow();
    expect(() => verifyRestrictedCodexThread(f.thread(f.cwd), f.cwd, platform)).not.toThrow(); // thread/start
    expect(() => verifyRestrictedCodexThread(f.thread(f.cwd), f.cwd, platform)).not.toThrow(); // thread/resume and fork
  });
  it('refuses an unverified client', () => {
    const f = fixture(platform);
    for (const userAgent of ['cezar/0.171.0-alpha.13', 'cezar/99.0.0', 'codex/0.169.0']) {
      expect(() => verifyRestrictedCodexIdentity({ ...f.identity, userAgent }, f.home, platform)).toThrow('protocol has not been verified');
    }
    expect(() => verifyRestrictedCodexIdentity({ userAgent: 'cezar/0.169.0' }, f.home, platform)).toThrow('not been verified');
  });
  it('refuses a platform Codex does not report itself, or an unknown one', () => {
    const f = fixture(platform);
    for (const platformOs of [platform.os === 'win32' ? 'macos' : 'windows', 'freebsd', undefined]) {
      expect(() => verifyRestrictedCodexIdentity({ ...f.identity, platformOs }, f.home, platform)).toThrow();
    }
  });
  it('refuses a foreign Codex home, config layer or relaxed sandbox on start and resume', () => {
    const f = fixture(platform);
    expect(() => verifyRestrictedCodexIdentity({ ...f.identity, codexHome: platform.os === 'win32' ? 'C:\\Users\\dev\\.codex' : '/home/dev/.codex' }, f.home, platform)).toThrow('isolated account home');
    const other = { ...f.configRead, layers: [{ name: { type: 'user', file: platform.os === 'win32' ? 'C:\\Users\\dev\\.codex\\config.toml' : '/home/dev/.codex/config.toml' }, config: f.home.config }] };
    expect(() => verifyRestrictedCodexConfig(other, f.home, platform)).toThrow('isolated config layer is missing');
    const managed = { ...f.configRead, layers: [...f.configRead.layers, { name: { type: 'mdm' }, config: { x: 1 } }] };
    expect(() => verifyRestrictedCodexConfig(managed, f.home, platform)).toThrow('unverified');
    for (const sandbox of [{ type: 'dangerFullAccess' }, { type: 'readOnly', networkAccess: true }, { type: 'workspaceWrite', networkAccess: false }, null]) {
      expect(() => verifyRestrictedCodexThread(f.thread(f.cwd, sandbox), f.cwd, platform)).toThrow('did not retain its sandbox');
    }
    expect(() => verifyRestrictedCodexThread(f.thread('/elsewhere'), f.cwd, platform)).toThrow('did not retain');
  });
});

describe('Windows path comparison', () => {
  it('ignores case, separators, trailing slash and the extended-length prefix, but never a different directory', () => {
    const f = fixture(WINDOWS_PLATFORM);
    expect(() => verifyRestrictedCodexIdentity({ ...f.identity, codexHome: '\\\\?\\c:\\users\\DEV\\.cezar\\codex-restricted\\ABC123\\' }, f.home, WINDOWS_PLATFORM)).not.toThrow();
    expect(() => verifyRestrictedCodexIdentity({ ...f.identity, codexHome: 'C:/Users/dev/.cezar/codex-restricted/abc123' }, f.home, WINDOWS_PLATFORM)).not.toThrow();
    const layer = { ...f.configRead, layers: [{ name: { type: 'user', file: '\\\\?\\C:\\Users\\dev\\.cezar\\codex-restricted\\abc123\\CONFIG.TOML' }, config: f.home.config }] };
    expect(() => verifyRestrictedCodexConfig(layer, f.home, WINDOWS_PLATFORM)).not.toThrow();
    expect(samePath(WINDOWS_PLATFORM, 'C:\\a\\b', 'C:\\a\\b2')).toBe(false);
    expect(samePath(WINDOWS_PLATFORM, 'C:\\a\\b', 'D:\\a\\b')).toBe(false);
  });
  it('keeps POSIX comparison case-sensitive', () => {
    expect(samePath(LINUX_PLATFORM, '/a/B', '/a/b')).toBe(false);
  });
});

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('restricted home for an injected Windows platform', () => {
  it('uses Windows-safe null devices and a sealed Windows PATH, without POSIX shell settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-win-home-')); dirs.push(root);
    const cwd = join(root, 'repo'); const native = join(root, 'native');
    // no auth files: nothing needs a symlink, so this also runs on a Windows host
    mkdirSync(cwd); mkdirSync(native);
    writeFileSync(join(native, 'config.toml'), 'model="m"\n');
    const home = prepareRestrictedCodexHome({ cwd }, { CEZ_HOME: join(root, 'cezar'), CODEX_HOME: native, SystemRoot: 'C:\\Windows' }, WINDOWS_PLATFORM);
    const set = (home.config.shell_environment_policy as { set: Record<string, string> }).set;
    expect(set.GIT_CONFIG_GLOBAL).toBe('NUL');
    expect(set.GIT_CONFIG_VALUE_2).toBe('NUL');
    expect(set.PATH).toBe('C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\Git\\cmd;C:\\Program Files\\GitHub CLI');
    expect(home.env.SHELL).toBeUndefined();
    expect(home.config.sandbox_mode).toBe('read-only');
    expect(home.config.approval_policy).toBe('never');
  });
});

describe('restricted runner platform guard', () => {
  it('refuses a platform that is not verified before spawning anything', () => {
    const runner = new CodexAppServerRunner({ bin: 'codex', restrictedPlatform: { os: 'freebsd', path: LINUX_PLATFORM.path } });
    expect(() => runner.startSession({ cwd: tmpdir(), userPrompt: 'x', allowedTools: ['Read'] })).toThrow('restricted execution is unavailable on this platform');
  });
});

describe('broker on any host', () => {
  it('allows a granted read and refuses a tool request outside the grant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-win-broker-')); dirs.push(root);
    writeFileSync(join(root, 'a.txt'), 'allowed read');
    const broker = new CodexReadBroker(compileCodexRestrictedPolicy({ allowedTools: ['Read'], bashAllowlist: [...CODEX_READ_PREFIXES] })!, { cwd: root }, {});
    try {
      expect((await broker.call({ tool: 'cezar_read', arguments: { tool: 'Read', path: 'a.txt' } })).contentItems[0]?.text).toBe('allowed read');
      for (const args of [{ tool: 'Bash', command: 'git status' }, { tool: 'Write', path: 'a.txt', content: 'x' }, { tool: 'Read', path: '..' + '/outside' }]) {
        expect((await broker.call({ tool: 'cezar_read', arguments: args })).success).toBe(false);
      }
      expect((await broker.call({ tool: 'native_shell', arguments: { tool: 'Read', path: 'a.txt' } })).success).toBe(false);
    } finally { broker.close(); }
  });
});
