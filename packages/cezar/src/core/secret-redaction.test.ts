import { describe, expect, it } from 'vitest';
import { collectSecretValues, redactDeep, redactSecrets, REDACTED } from './secret-redaction.ts';

/**
 * #427: credentials must never be persisted to a run's NDJSON transcript.
 * Value-based redaction scrubs the host's own secret env values; pattern-based
 * redaction catches well-known token shapes from anywhere.
 */
describe('collectSecretValues', () => {
  it('collects values of secret-named vars, skips short and non-secret names', () => {
    const values = collectSecretValues({
      GITHUB_TOKEN: 'gho_averylongtokenvalue',
      AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMIabcdefghij',
      PATH: '/usr/bin:/bin',
      SSH_AUTH_SOCK: '/tmp/ssh-abc/agent.1', // AUTH but allow-listed
      SHORT_TOKEN: 'abc', // too short
    });
    expect(values).toContain('gho_averylongtokenvalue');
    expect(values).toContain('wJalrXUtnFEMIabcdefghij');
    expect(values).not.toContain('/usr/bin:/bin');
    expect(values).not.toContain('/tmp/ssh-abc/agent.1');
    expect(values).not.toContain('abc');
  });

  /** #427 review: the shared SECRET_NAME_RE means a var stripped from the
   *  child env is also collected for redaction — the two used to diverge. */
  it('collects the name shapes agent-env strips, so the lists cannot drift', () => {
    const values = collectSecretValues({
      SIGNING_KEY: 'signingkeyvalue123',
      MY_KEY_MATERIAL: 'keymaterialvalue123',
      SESSION_SECRET: 'sessionsecretvalue123',
      COOKIE_SIGNING: 'cookiesigningvalue123',
    });
    expect(values).toEqual(
      expect.arrayContaining([
        'signingkeyvalue123',
        'keymaterialvalue123',
        'sessionsecretvalue123',
        'cookiesigningvalue123',
      ]),
    );
  });

  it('skips session/desktop bookkeeping whose value is a path, not a credential', () => {
    const values = collectSecretValues({
      SESSION_MANAGER: 'local/host:@/tmp/.ICE-unix/1234',
      XDG_SESSION_TYPE: 'wayland-session-type',
    });
    expect(values).toEqual([]);
  });
});

describe('redactSecrets', () => {
  it('scrubs concrete host secret values found in text', () => {
    const secrets = collectSecretValues({ GITHUB_TOKEN: 'gho_myrealsecrettoken1234' });
    const out = redactSecrets('run: gh auth uses gho_myrealsecrettoken1234 here', secrets);
    expect(out).not.toContain('gho_myrealsecrettoken1234');
    expect(out).toContain(REDACTED);
  });

  it('scrubs well-known token shapes even without knowing the env', () => {
    const line = [
      'gh: ghp_0123456789abcdefghijABCDEFGHIJ0123',
      'anthropic: sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'aws: AKIAIOSFODNN7EXAMPLE',
      'google: AIzaSyA0123456789abcdefghijklmnopqrstuv',
    ].join('\n');
    const out = redactSecrets(line, []);
    expect(out).not.toMatch(/ghp_|sk-ant|AKIA|AIza/);
    expect(out.match(new RegExp(REDACTED.replace(/[[\]]/g, '\\$&'), 'g'))?.length).toBe(4);
  });

  it('leaves non-secret text untouched', () => {
    expect(redactSecrets('the quick brown fox', [])).toBe('the quick brown fox');
  });

  /**
   * #427 review: the old 8-char floor mangled ordinary output — a dev box with
   * `POSTGRES_PASSWORD=postgres` turned `apt install postgresql-16` into
   * `apt install [REDACTED]ql-16`. Short dictionary words are not redactable.
   */
  it('does not redact short dictionary-word "secrets" out of ordinary output', () => {
    const secrets = collectSecretValues({ POSTGRES_PASSWORD: 'postgres', DB_PASSWORD: 'root' });
    expect(secrets).toEqual([]);
    const line = 'apt install postgresql-16 && psql -U postgres -c "select 1"';
    expect(redactSecrets(line, secrets)).toBe(line);
  });

  it('still redacts a real credential value at the raised floor', () => {
    const secrets = collectSecretValues({ POSTGRES_PASSWORD: 'S3cr3t-Pr0d-Passw0rd' });
    const out = redactSecrets('psql://app:S3cr3t-Pr0d-Passw0rd@db/prod', secrets);
    expect(out).not.toContain('S3cr3t-Pr0d-Passw0rd');
    expect(out).toContain(REDACTED);
  });
});

/**
 * Spec 2026-08-10-forge-provider-adapters, Step 4.3: GitLab issues several token shapes beyond
 * the personal access token (`glpat-`) that `secret-redaction.ts` already caught — deploy tokens,
 * runner tokens, CI/CD job tokens, etc. Each gets its own row so a regression in one prefix's
 * regex (wrong length floor, wrong body class) fails on its own line.
 */
describe('redactSecrets — GitLab token prefixes', () => {
  const cases: Array<[string, string]> = [
    ['personal access token', 'glpat-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['OAuth application secret', 'gloas-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['deploy token', 'gldt-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['runner authentication token', 'glrt-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['CI/CD job token', 'glcbt-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['pipeline trigger token', 'glptt-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['feed token', 'glft-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['incoming mail token', 'glimt-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['agent (Kubernetes) token', 'glagent-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['SCIM OAuth access token', 'glsoat-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['feature flags client token', 'glffct-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['workspace token', 'glwt-AbCdEfGhIjKlMnOpQrStUvWx'],
  ];

  it.each(cases)('redacts a %s (%s)', (_label, token) => {
    const out = redactSecrets(`export TOKEN=${token}`, []);
    expect(out).not.toContain(token);
    expect(out).toContain(REDACTED);
  });

  it('does not redact an ordinary word that merely starts with a GitLab-like prefix', () => {
    // Short / non-hyphenated / dictionary text that must never be mistaken for a token: the
    // patterns require the literal `gl*-` prefix AND a 20+ char body, so plain words survive.
    const line = 'glossary glass globe glimpse gladly glacier';
    expect(redactSecrets(line, [])).toBe(line);
  });

  it('does not redact a short glab-prefixed value under the 20-char body floor', () => {
    const line = 'export TOKEN=glpat-tooshort';
    expect(redactSecrets(line, [])).toBe(line);
  });
});

describe('redactDeep', () => {
  it('scrubs string leaves in nested event structures', () => {
    const event = {
      type: 'tool-result',
      result: 'export GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ0123',
      item: { output: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', nested: [{ text: 'safe' }] },
      seq: 3,
    };
    const out = redactDeep(event, []);
    expect(out.result).not.toContain('ghp_');
    expect((out.item as { output: string }).output).not.toContain('sk-ant');
    expect(out.seq).toBe(3); // non-strings preserved
    expect((out.item as { nested: Array<{ text: string }> }).nested[0]?.text).toBe('safe');
  });
});

it('redacts raw tracker key values from persisted task text', () => {
  const secrets = collectSecretValues({ JIRA_API_TOKEN: 'jira-token-value', LINEAR_API_KEY: 'linear-key-value' });
  expect(redactSecrets('jira-token-value linear-key-value', secrets)).toBe(REDACTED + ' ' + REDACTED);
});
