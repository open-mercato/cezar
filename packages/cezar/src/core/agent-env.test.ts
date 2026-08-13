import { describe, expect, it } from 'vitest';
import { buildChildEnv, looksSecret } from './agent-env.ts';

/**
 * #427: the spawned backend must NOT inherit the full host environment. It
 * gets a curated allowlist — safe shell/toolchain vars + the backend's own
 * auth + gh + cezar's `CEZ_*` — and nothing else.
 */
describe('buildChildEnv — least-privilege child env (#427)', () => {
  const HOST: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/dev',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm',
    SSH_AUTH_SOCK: '/tmp/ssh-abc/agent.1',
    NODE_OPTIONS: '--max-old-space-size=4096',
    CARGO_HOME: '/home/dev/.cargo',
    // Secrets that must be dropped:
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    STRIPE_SECRET_KEY: 'sk_live_supersecretxxxxxxxx',
    NODE_AUTH_TOKEN: 'npm_tokenshouldnotleak',
    RANDOM_PASSWORD: 'hunter2hunter2',
  };

  it('forwards safe base + toolchain vars', () => {
    const env = buildChildEnv({ backend: 'claude', source: HOST });
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/dev');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.TERM).toBe('xterm');
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/ssh-abc/agent.1');
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
    expect(env.CARGO_HOME).toBe('/home/dev/.cargo');
  });

  it('drops arbitrary host secrets (AWS creds, stripe key, npm token, passwords)', () => {
    const env = buildChildEnv({ backend: 'claude', source: HOST });
    // No Bedrock/Vertex toggle here, so the AWS creds are not auth the backend
    // needs — the default direct-API posture drops them (see the toggle tests).
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.NODE_AUTH_TOKEN).toBeUndefined(); // secret name beats NODE_ prefix
    expect(env.RANDOM_PASSWORD).toBeUndefined();
  });

  it('forwards the backend auth it genuinely needs, but not another backend’s', () => {
    const src = { ...HOST, ANTHROPIC_API_KEY: 'sk-ant-xyz', OPENAI_API_KEY: 'sk-openai-xyz' };
    const claude = buildChildEnv({ backend: 'claude', source: src });
    expect(claude.ANTHROPIC_API_KEY).toBe('sk-ant-xyz');
    expect(claude.OPENAI_API_KEY).toBeUndefined();

    const codex = buildChildEnv({ backend: 'codex', source: src });
    expect(codex.OPENAI_API_KEY).toBe('sk-openai-xyz');
    expect(codex.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('keeps GITHUB_TOKEN for the gh handoff and the CEZ_* namespace', () => {
    const src = {
      ...HOST,
      GITHUB_TOKEN: 'gho_token',
      CEZ_DRY_RUN: '1',
      CEZ_MOCK_ARGS_FILE: '/tmp/args',
    };
    const env = buildChildEnv({ backend: 'claude', source: src });
    expect(env.GITHUB_TOKEN).toBe('gho_token');
    expect(env.CEZ_DRY_RUN).toBe('1');
    expect(env.CEZ_MOCK_ARGS_FILE).toBe('/tmp/args');
  });

  it('applies extraEnv (spec.env) last so per-run vars always win', () => {
    const env = buildChildEnv({
      backend: 'claude',
      source: { ...HOST, PATH: '/host' },
      extraEnv: { CEZ_HANDOFF_FILE: '/runs/x.md', PATH: '/override' },
    });
    expect(env.CEZ_HANDOFF_FILE).toBe('/runs/x.md');
    expect(env.PATH).toBe('/override');
  });

  /**
   * #785: the run's own temp directory is delivered as `extraEnv`, and it only
   * works if it genuinely REPLACES the host's. The host copy must be gone, not
   * merely shadowed — env names are matched case-insensitively (and Windows
   * treats them that way), so a surviving `Temp`/`Tmp` beside our `TEMP`/`TMP`
   * would hand the backend the exhausted host directory under another spelling.
   */
  describe('per-run temp directory replaces the host’s (#785)', () => {
    it('overrides all three spellings when the host set all three', () => {
      const env = buildChildEnv({
        backend: 'claude',
        source: { ...HOST, TMPDIR: '/tmp', TEMP: '/tmp', TMP: '/tmp' },
        extraEnv: { TMPDIR: '/data/tmp/run-1', TEMP: '/data/tmp/run-1', TMP: '/data/tmp/run-1' },
      });
      expect(env.TMPDIR).toBe('/data/tmp/run-1');
      expect(env.TEMP).toBe('/data/tmp/run-1');
      expect(env.TMP).toBe('/data/tmp/run-1');
    });

    it('leaves no host-cased duplicate pointing back at the shared directory', () => {
      const env = buildChildEnv({
        backend: 'claude',
        source: { ...HOST, Temp: 'C:\\Windows\\Temp', Tmp: 'C:\\Windows\\Temp' },
        extraEnv: { TMPDIR: 'D:\\run-1', TEMP: 'D:\\run-1', TMP: 'D:\\run-1' },
      });
      const tempish = Object.entries(env).filter(([k]) => /^(tmpdir|temp|tmp)$/i.test(k));
      expect(tempish.map(([, v]) => v)).toEqual(['D:\\run-1', 'D:\\run-1', 'D:\\run-1']);
    });

    it('the host value still comes through when the run overrides nothing', () => {
      const env = buildChildEnv({ backend: 'claude', source: { ...HOST, TMPDIR: '/tmp' } });
      expect(env.TMPDIR).toBe('/tmp');
    });

    it('the escape hatch does not resurrect the host value either', () => {
      const env = buildChildEnv({
        backend: 'claude',
        source: { ...HOST, CEZ_AGENT_ENV_FULL: '1', Temp: 'C:\\Windows\\Temp' },
        extraEnv: { TEMP: 'D:\\run-1' },
      });
      expect(env.Temp).toBeUndefined();
      expect(env.TEMP).toBe('D:\\run-1');
    });
  });

  it('opt-in CEZ_ENV_PASSTHROUGH forwards named extras', () => {
    const src = { ...HOST, MY_TOOLCHAIN_DIR: '/opt/tc', CEZ_ENV_PASSTHROUGH: 'MY_TOOLCHAIN_DIR' };
    const env = buildChildEnv({ backend: 'claude', source: src });
    expect(env.MY_TOOLCHAIN_DIR).toBe('/opt/tc');
  });

  it('opt-in CEZ_AGENT_ENV_FULL=1 restores legacy full inheritance (escape hatch)', () => {
    const src = { ...HOST, CEZ_AGENT_ENV_FULL: '1' };
    const env = buildChildEnv({ backend: 'claude', source: src });
    expect(env.AWS_SECRET_ACCESS_KEY).toBe(HOST.AWS_SECRET_ACCESS_KEY);
  });

  /**
   * #456 review: the hatch parsed with an exact `=== '1'` while the
   * Bedrock/Vertex toggles beside it used `isTruthy`, so `=true` silently did
   * nothing. One parser, one answer — and the off/absent spellings must still
   * mean "stay hardened", since this hatch fails OPEN.
   */
  it.each(['1', 'true', 'yes'])('CEZ_AGENT_ENV_FULL=%s enables the hatch', (value) => {
    const env = buildChildEnv({ backend: 'claude', source: { ...HOST, CEZ_AGENT_ENV_FULL: value } });
    expect(env.AWS_SECRET_ACCESS_KEY).toBe(HOST.AWS_SECRET_ACCESS_KEY);
  });

  it.each(['0', 'false', ''])('CEZ_AGENT_ENV_FULL=%s stays hardened', (value) => {
    const env = buildChildEnv({ backend: 'claude', source: { ...HOST, CEZ_AGENT_ENV_FULL: value } });
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});

/**
 * #427 review (BLOCKER): Windows spells its essentials `Path`, `SystemRoot`,
 * `ComSpec`, `windir` and has no `HOME`. Exact-case matching dropped every one
 * of them, so the child env had no PATH and the backend binary could not be
 * resolved — every run on win32 broke. Matching is case-insensitive; the
 * original spelling must survive, because Windows tooling reads `Path`.
 */
describe('buildChildEnv — Windows-shaped env (#427 review)', () => {
  const WIN: NodeJS.ProcessEnv = {
    Path: 'C:\\Windows\\system32;C:\\Program Files\\nodejs',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    SystemRoot: 'C:\\Windows',
    SystemDrive: 'C:',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    windir: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\dev',
    APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
    TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\dev\\AppData\\Local\\Temp',
    ProgramFiles: 'C:\\Program Files',
    // No HOME on Windows.
  };

  it('keeps the vars a spawned binary needs, under their original casing', () => {
    const env = buildChildEnv({ backend: 'claude', source: WIN });
    expect(env.Path).toBe('C:\\Windows\\system32;C:\\Program Files\\nodejs');
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.ComSpec).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(env.windir).toBe('C:\\Windows');
    expect(env.USERPROFILE).toBe('C:\\Users\\dev');
    expect(env.APPDATA).toBe('C:\\Users\\dev\\AppData\\Roaming');
    expect(env.LOCALAPPDATA).toBe('C:\\Users\\dev\\AppData\\Local');
    expect(env.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD');
    expect(env.SystemDrive).toBe('C:');
    expect(env.ProgramFiles).toBe('C:\\Program Files');
    expect(env.TEMP).toBe('C:\\Users\\dev\\AppData\\Local\\Temp');
    // The key is NOT normalized: an upper-cased `PATH` would be a second,
    // unrelated var to Windows tooling that reads `Path`.
    expect(Object.keys(env)).toContain('Path');
    expect(Object.keys(env)).not.toContain('PATH');
  });

  it('still drops secrets whatever their casing', () => {
    const env = buildChildEnv({
      backend: 'claude',
      source: { ...WIN, Node_Auth_Token: 'npm_shouldnotleak', Stripe_Secret_Key: 'sk_live_x' },
    });
    expect(env.Node_Auth_Token).toBeUndefined(); // secret name beats the NODE_ prefix
    expect(env.Stripe_Secret_Key).toBeUndefined();
  });

  it('honors lower-cased proxy vars and CEZ_* / passthrough case-insensitively', () => {
    const env = buildChildEnv({
      backend: 'claude',
      source: { ...WIN, http_proxy: 'http://p:3128', CEZ_ENV_PASSTHROUGH: 'my_tool_dir', my_tool_dir: 'C:\\tc' },
    });
    expect(env.http_proxy).toBe('http://p:3128');
    expect(env.my_tool_dir).toBe('C:\\tc');
  });
});

/**
 * #427 review (MAJOR): `CLAUDE_CODE_USE_BEDROCK` / `_USE_VERTEX` ride in on the
 * `CLAUDE_` prefix. Forwarding the toggle while dropping the credentials it
 * switches the SDK over to is a hard auth failure, so each toggle unlocks its
 * own creds — and only while it is on.
 */
describe('buildChildEnv — Bedrock/Vertex toggles (#427 review)', () => {
  const AWS = {
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    AWS_SESSION_TOKEN: 'FwoGZXIvYXdzEExample',
    AWS_REGION: 'us-east-1',
    AWS_DEFAULT_REGION: 'us-east-1',
    AWS_PROFILE: 'dev',
    AWS_BEARER_TOKEN_BEDROCK: 'bedrock-bearer-xyz',
  };
  const GCP = {
    GOOGLE_APPLICATION_CREDENTIALS: '/home/dev/gcp.json',
    CLOUD_ML_REGION: 'us-east5',
    ANTHROPIC_VERTEX_PROJECT_ID: 'my-project',
    GOOGLE_CLOUD_PROJECT: 'my-project',
  };

  it('CLAUDE_CODE_USE_BEDROCK=1 forwards the toggle AND the AWS creds it needs', () => {
    const env = buildChildEnv({
      backend: 'claude',
      source: { PATH: '/usr/bin', CLAUDE_CODE_USE_BEDROCK: '1', ...AWS },
    });
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    for (const [k, v] of Object.entries(AWS)) expect(env[k]).toBe(v);
  });

  it('without the toggle the same AWS creds are dropped (least-privilege default)', () => {
    const env = buildChildEnv({ backend: 'claude', source: { PATH: '/usr/bin', ...AWS } });
    for (const k of Object.keys(AWS)) expect(env[k]).toBeUndefined();
  });

  it('CLAUDE_CODE_USE_BEDROCK=0 is not a toggle — creds stay dropped', () => {
    const env = buildChildEnv({
      backend: 'claude',
      source: { PATH: '/usr/bin', CLAUDE_CODE_USE_BEDROCK: '0', ...AWS },
    });
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('CLAUDE_CODE_USE_VERTEX=1 forwards the GCP config it needs, but not AWS', () => {
    const env = buildChildEnv({
      backend: 'claude',
      source: { PATH: '/usr/bin', CLAUDE_CODE_USE_VERTEX: 'true', ...GCP, ...AWS },
    });
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe('/home/dev/gcp.json');
    expect(env.CLOUD_ML_REGION).toBe('us-east5');
    expect(env.ANTHROPIC_VERTEX_PROJECT_ID).toBe('my-project');
    expect(env.GOOGLE_CLOUD_PROJECT).toBe('my-project');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined(); // vertex ≠ bedrock
  });

  it('a backend that never sees the toggle never gets the creds either', () => {
    const env = buildChildEnv({
      backend: 'codex',
      source: { PATH: '/usr/bin', CLAUDE_CODE_USE_BEDROCK: '1', ...AWS },
    });
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});

/**
 * Agent accounts (spec 2026-07-29-agent-profiles) reach the child through `extraEnv`, which is
 * applied AFTER the allowlist and so bypasses it. That makes `profileEnv` the only gatekeeper —
 * these pin the two properties the rest of the design leans on.
 */
describe('agent-profile config dirs reach the child', () => {
  it('CLAUDE_CONFIG_DIR survives for claude, and via the host allowlist too', () => {
    expect(
      buildChildEnv({
        backend: 'claude',
        extraEnv: { CLAUDE_CONFIG_DIR: '/home/u/.claude-klaudiusz' },
        source: { PATH: '/usr/bin' },
      }).CLAUDE_CONFIG_DIR,
    ).toBe('/home/u/.claude-klaudiusz');
    // The `CLAUDE_` prefix means a host-level override also rides in, which is what makes it the
    // DEFAULT profile's dir rather than something cezar has to re-export.
    expect(
      buildChildEnv({
        backend: 'claude',
        source: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/home/u/.claude-host' },
      }).CLAUDE_CONFIG_DIR,
    ).toBe('/home/u/.claude-host');
  });

  it('CODEX_HOME survives for codex', () => {
    expect(
      buildChildEnv({
        backend: 'codex',
        extraEnv: { CODEX_HOME: '/home/u/.codex-klaudiusz' },
        source: { PATH: '/usr/bin' },
      }).CODEX_HOME,
    ).toBe('/home/u/.codex-klaudiusz');
  });

  it('the per-run account still wins under the CEZ_AGENT_ENV_FULL escape hatch', () => {
    // The hatch restores full inheritance, but `extraEnv` is applied last there too — otherwise
    // a host-level CLAUDE_CONFIG_DIR would silently outrank the account the user picked.
    const env = buildChildEnv({
      backend: 'claude',
      extraEnv: { CLAUDE_CONFIG_DIR: '/home/u/.claude-klaudiusz' },
      source: { PATH: '/usr/bin', CEZ_AGENT_ENV_FULL: '1', CLAUDE_CONFIG_DIR: '/home/u/.claude' },
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude-klaudiusz');
  });
});

describe('looksSecret', () => {
  it('flags credential-shaped names', () => {
    for (const n of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'FOO_API_KEY', 'DB_PASSWORD', 'NODE_AUTH_TOKEN']) {
      expect(looksSecret(n)).toBe(true);
    }
  });
  it('does not flag ordinary names', () => {
    for (const n of ['PATH', 'HOME', 'NODE_OPTIONS', 'CARGO_HOME', 'LANG']) {
      expect(looksSecret(n)).toBe(false);
    }
  });
});
