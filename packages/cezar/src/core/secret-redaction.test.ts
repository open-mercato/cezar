import { spawnSync } from 'node:child_process';
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

  /** A word ending in "sk" is not a key: `task-…` used to come out as `ta[REDACTED]`. */
  it('leaves hyphenated words that merely end in "sk" alone', () => {
    const line = [
      'fix task-scheduling-and-priority-queue',
      'refactor desk-booking-calendar-widget-v2',
      'risk-assessment-matrix-for-payments',
      'e2e fixture task-columns-workflow-folded',
      'task-ant-colony-optimisation-heuristics',
    ].join('\n');
    expect(redactSecrets(line, [])).toBe(line);
  });

  it('still redacts OpenAI and Anthropic key shapes wherever a key can stand', () => {
    const keys = [
      `sk-${'A1b2C3d4'.repeat(6)}`, // legacy: sk- + 48
      `sk-proj-${'Ab3_Cd4-'.repeat(8)}`,
      `sk-svcacct-${'Zz9Yy8Xx'.repeat(4)}`,
      `sk-ant-api03-${'Q7r_S8t-'.repeat(6)}AA`,
    ];
    for (const key of keys) {
      for (const text of [key, `OPENAI_API_KEY=${key}`, `{"key":"${key}"}`, `Authorization: Bearer ${key}`, `x-api-key:${key}`, `--key=${key}`]) {
        expect(redactSecrets(text, [])).toBe(text.replace(key, REDACTED));
      }
    }
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

describe('overlapping known values', () => {
  it.each([false, true])('redacts receiver prefixes independently of order (%s)', reverse => {
    const values = ['https://receiver.invalid/', 'https://receiver.invalid/?token=private-capability'];
    expect(redactSecrets('Failed ' + values[1], reverse ? [...values].reverse() : values)).toBe('Failed ' + REDACTED);
  });
  it('covers crossing matches and self-overlaps in the original text', () => {
    expect(redactSecrets('abcdefghij', ['abcdef', 'defghij'])).toBe(REDACTED);
    expect(redactSecrets('ababa', ['aba'])).toBe(REDACTED);
  });
  it('ignores empty values, deduplicates and does not rewrite replacement markers', () => {
    expect(redactSecrets('a short key z', ['', 'short key', 'short key', 'REDACTED'])).toBe('a ' + REDACTED + ' z');
  });
});

describe('original-text coverage', () => {
  it('keeps touching matches separate and matches original marker text', () => {
    expect(redactSecrets('abab', ['ab'])).toBe(REDACTED.repeat(2));
    expect(redactSecrets('[REDACTED] key', ['REDACTED', 'key'])).toBe(`[${REDACTED}] ${REDACTED}`);
    expect(redactSecrets('😀😀😀', ['😀😀'])).toBe(REDACTED);
  });

  it('redacts whole token shapes even when known literals cover a prefix or interior', () => {
    for (const token of [`whsec_${'A'.repeat(40)}`, `ghp_${'b'.repeat(30)}`, `sk-ant-${'c'.repeat(30)}`]) {
      for (const value of [token.slice(0, 12), token.slice(10, 22), token.slice(-12)]) {
        expect(redactSecrets(`before ${token} after`, [value])).toBe(`before ${REDACTED} after`);
      }
    }
  });

  it('unions crossing token patterns against the original text', () => {
    const token = `whsec_${'a'.repeat(32)}ghp_${'b'.repeat(24)}`;
    expect(redactSecrets(token, [])).toBe(REDACTED);
  });

  it('handles millions of redundant overlapping occurrences', () => {
    const values = Array.from({ length: 32 }, (_, i) => 'x'.repeat(12 + i));
    expect(redactSecrets('x'.repeat(128 * 1024), values)).toBe(REDACTED);
  });

  it('fits dense overlap matching in a bounded worker heap', () => {
    const moduleUrl = new URL('./secret-redaction.ts', import.meta.url).href;
    const worker = spawnSync(process.execPath, [
      '--import', 'tsx', '--max-old-space-size=64', '--input-type=module', '--eval',
      `import { redactSecrets, REDACTED } from ${JSON.stringify(moduleUrl)};
       const values = Array.from({ length: 32 }, (_, i) => 'x'.repeat(12 + i));
       if (redactSecrets('x'.repeat(128 * 1024), values) !== REDACTED) process.exit(1);`,
    ], { encoding: 'utf8', timeout: 20_000 });
    // A resource bound, not a timing assertion: retaining all four million
    // tuples exhausts this heap; endpoint coverage needs just 512 KiB.
    expect(worker.error).toBeUndefined();
    expect(worker.status, worker.stderr).toBe(0);
  });

  it('agrees with an independent interval oracle for varied literal overlaps', () => {
    let seed = 427;
    const random = (bound: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % bound;
    };
    const word = (length: number): string => Array.from({ length }, () => 'abc'[random(3)]).join('');
    for (let trial = 0; trial < 500; trial++) {
      const text = word(random(60));
      const values = Array.from({ length: random(12) }, () => word(random(8)));
      const intervals: [number, number][] = [];
      for (let start = 0; start < text.length; start++) {
        for (const value of values) {
          if (value && text.startsWith(value, start)) intervals.push([start, start + value.length]);
        }
      }
      intervals.sort((a, b) => a[0] - b[0]);
      const union: [number, number][] = [];
      for (const [start, end] of intervals) {
        const last = union.at(-1);
        if (last && start < last[1]) last[1] = Math.max(last[1], end);
        else union.push([start, end]);
      }
      let expected = text;
      for (const [start, end] of union.reverse()) {
        expected = expected.slice(0, start) + REDACTED + expected.slice(end);
      }
      expect(redactSecrets(text, values)).toBe(expected);
    }
  });
});
