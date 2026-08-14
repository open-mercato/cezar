import { describe, expect, it } from 'vitest';
import { isLoopbackHost, isLoopbackHostHeader, normalizeHostname, resolveCapabilities } from './capabilities.ts';

/**
 * `resolveCapabilities` takes its env as a parameter, so these drive it
 * directly rather than mutating `process.env`.
 *
 * The two loopback predicates sit at different trust seams and must not be
 * collapsed into one (#426 / #467 review):
 *   - `isLoopbackHost(bindHost)`   — our own config. Undefined = "we defaulted
 *                                     to the loopback bind" ⇒ trusted.
 *   - `isLoopbackHostHeader(host)` — an attacker-controlled request header.
 *                                     Absent or unparseable ⇒ untrusted.
 * Both share an *anchored* address match: a `127.` string prefix also matches
 * registrable hostnames like `127.0.0.1.evil.com`, which was the DNS-rebinding
 * bypass this pair replaced.
 */

const REAL_LOOPBACK = [
  'localhost',
  'LOCALHOST',
  '127.0.0.1',
  '127.1.2.3',
  '127.255.255.255',
  '::1',
  '[::1]',
  '0:0:0:0:0:0:0:1',
];

// Every one of these is registrable by an attacker and resolvable to 127.0.0.1.
const NOT_LOOPBACK = [
  '127.0.0.1.evil.com',
  '127.evil.com',
  '127.0.0.1.nip.io',
  '1270.0.0.1',
  '127.0.0.1x',
  '127.0.0.256',
  '127.0.0',
  'localhost.evil.com',
  // Malformed authorities: a lax parser normalizes each of these down to a
  // loopback name. They must fail closed instead.
  '[::1]@evil.com',
  '[::1]evil.com',
  '[::1]x',
  '127.0.0.1%2eevil.com',
  'localhost%.evil.com',
  '127.0.0.1:evil.com',
  'evil.com:80:127.0.0.1',
  '0.0.0.0',
  '192.168.1.10',
  'example.com',
  '::2',
  '::1:1',
];

describe('normalizeHostname', () => {
  it.each([
    ['127.0.0.1:4321', '127.0.0.1'],
    // IPv6 is canonicalized to all 8 groups, so every spelling of ::1 — and the
    // compressed form `new URL().hostname` emits — compares equal.
    ['[::1]:4321', '0:0:0:0:0:0:0:1'],
    ['[0:0:0:0:0:0:0:1]:4321', '0:0:0:0:0:0:0:1'],
    ['[0000:0000:0000:0000:0000:0000:0000:0001]', '0:0:0:0:0:0:0:1'],
    ['::1', '0:0:0:0:0:0:0:1'], // bare IPv6 literal: >1 colon, so never `name:port`
    ['LocalHost.:4321', 'localhost'], // lowercased, trailing FQDN dot dropped
    ['fe80::1%eth0', 'fe80:0:0:0:0:0:0:1'], // IPv6 zone id stripped
    ['[::1%25eth0]:4321', '0:0:0:0:0:0:0:1'], // bracketed, zone id + port
  ])('normalizes %s → %s', (input, expected) => {
    expect(normalizeHostname(input)).toBe(expected);
  });

  it.each([
    '[::1]@evil.com', // trailing junk after the bracket
    '[::1]evil.com',
    '127.0.0.1:evil.com', // port that is not digits
    'evil.com:80:127.0.0.1',
  ])('returns "" for the unparseable authority %s', (input) => {
    expect(normalizeHostname(input)).toBe('');
  });

  it('only strips a % zone id at the end, never mid-hostname', () => {
    // `.replace(/%.*$/, '')` would truncate these to a loopback name.
    expect(normalizeHostname('127.0.0.1%2eevil.com')).toBe('127.0.0.1%2eevil.com');
    expect(normalizeHostname('localhost%.evil.com')).toBe('localhost%.evil.com');
  });
});

describe('isLoopbackHostHeader (untrusted request header)', () => {
  it.each(REAL_LOOPBACK)('accepts the real loopback host %s', (host) => {
    expect(isLoopbackHostHeader(host)).toBe(true);
  });

  it.each(NOT_LOOPBACK)('rejects the non-loopback host %s', (host) => {
    expect(isLoopbackHostHeader(host)).toBe(false);
  });

  it('rejects a missing Host header — absent is untrusted, not "defaulted"', () => {
    expect(isLoopbackHostHeader(undefined)).toBe(false);
    expect(isLoopbackHostHeader('')).toBe(false);
  });

  it('accepts loopback hosts that carry a port or brackets', () => {
    expect(isLoopbackHostHeader('127.0.0.1:4321')).toBe(true);
    expect(isLoopbackHostHeader('[::1]:4321')).toBe(true);
    expect(isLoopbackHostHeader('localhost.:4321')).toBe(true);
  });
});

describe('isLoopbackHost (our own bind host)', () => {
  it('treats the default bind (undefined) as loopback', () => {
    expect(isLoopbackHost(undefined)).toBe(true);
  });

  it.each(REAL_LOOPBACK)('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(NOT_LOOPBACK)('rejects %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('resolveCapabilities — localHandoff', () => {
  it('is on for a default local bind', () => {
    expect(resolveCapabilities({}, undefined).localHandoff).toBe(true);
  });

  it('is on for an explicit loopback bind', () => {
    expect(resolveCapabilities({}, '127.0.0.1').localHandoff).toBe(true);
  });

  it('is off when CEZ_REMOTE=1', () => {
    expect(resolveCapabilities({ CEZ_REMOTE: '1' }, undefined).localHandoff).toBe(false);
  });

  it('is off for a non-loopback bind host', () => {
    expect(resolveCapabilities({}, '0.0.0.0').localHandoff).toBe(false);
  });
});

describe('resolveCapabilities — followups (#471)', () => {
  it('is OFF by default — the global inbox is opt-in', () => {
    expect(resolveCapabilities({}, undefined).followups).toBe(false);
  });

  it('is on with CEZ_FOLLOWUPS=1', () => {
    expect(resolveCapabilities({ CEZ_FOLLOWUPS: '1' }, undefined).followups).toBe(true);
  });

  it.each(['0', 'true', 'yes', '', 'on'])(
    'stays off for CEZ_FOLLOWUPS=%j — only an exact "1" opts in',
    (value) => {
      expect(resolveCapabilities({ CEZ_FOLLOWUPS: value }, undefined).followups).toBe(false);
    },
  );

  it('is independent of the deployment mode', () => {
    expect(resolveCapabilities({ CEZ_FOLLOWUPS: '1', CEZ_REMOTE: '1' }, '0.0.0.0')).toEqual({
      localHandoff: false,
      followups: true,
      singleProject: false,
      automations: false,
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
    });
  });
});

describe('resolveCapabilities — singleProject', () => {
  it('is off by default', () => {
    expect(resolveCapabilities({}).singleProject).toBe(false);
  });

  it('is on with CEZ_SINGLE_PROJECT=1', () => {
    expect(resolveCapabilities({ CEZ_SINGLE_PROJECT: '1' }).singleProject).toBe(true);
  });

  it.each(['0', 'true', 'yes', '', 'on'])(
    'stays off for CEZ_SINGLE_PROJECT=%j — only an exact "1" opts in',
    (value) => {
      expect(resolveCapabilities({ CEZ_SINGLE_PROJECT: value }).singleProject).toBe(false);
    },
  );
});

describe('resolveCapabilities — automations (#801)', () => {
  it('is OFF by default — GitHub automations are opt-in', () => {
    expect(resolveCapabilities({}).automations).toBe(false);
  });

  it('is on with CEZ_AUTOMATIONS=1', () => {
    expect(resolveCapabilities({ CEZ_AUTOMATIONS: '1' }).automations).toBe(true);
  });

  it.each(['0', 'true', 'yes', '', 'on'])(
    'stays off for CEZ_AUTOMATIONS=%j — only an exact "1" opts in',
    (value) => {
      expect(resolveCapabilities({ CEZ_AUTOMATIONS: value }).automations).toBe(false);
    },
  );

  // The three opt-in capabilities are independent switches; turning one on must never
  // imply another, or a user enabling automations would silently get the inbox too.
  it('does not turn on any other opt-in capability', () => {
    expect(resolveCapabilities({ CEZ_AUTOMATIONS: '1' })).toMatchObject({
      automations: true,
      followups: false,
      singleProject: false,
    });
  });
});

describe('resolveCapabilities — usage presentation', () => {
  it('shows token usage and cost by default', () => {
    expect(resolveCapabilities({})).toMatchObject({
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
    });
  });

  it.each([
    [{ CEZ_HIDE_TOKEN_METRICS: '1' }, false, false, false],
    [{ CEZ_HIDE_TOKEN_USAGE: '1' }, false, false, true],
    [{ CEZ_HIDE_COST: '1' }, false, true, false],
    [{ CEZ_HIDE_TOKEN_USAGE: '1', CEZ_HIDE_COST: '1' }, false, false, false],
    [{ CEZ_HIDE_TOKEN_METRICS: '1', CEZ_HIDE_TOKEN_USAGE: '0', CEZ_HIDE_COST: '0' }, false, false, false],
  ] as const)(
    'resolves strict visibility for %o',
    (env, tokenMetrics, tokenUsageMetrics, costMetrics) => {
      expect(resolveCapabilities(env)).toMatchObject({ tokenMetrics, tokenUsageMetrics, costMetrics });
    },
  );

  it.each(['0', 'true', 'yes', '', 'on'])(
    'stays visible for CEZ_HIDE_TOKEN_METRICS=%j — only an exact "1" opts out',
    (value) => {
      expect(resolveCapabilities({
        CEZ_HIDE_TOKEN_METRICS: value,
        CEZ_HIDE_TOKEN_USAGE: value,
        CEZ_HIDE_COST: value,
      })).toMatchObject({ tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true });
    },
  );

  it('does not change telemetry visibility when another deployment capability is enabled', () => {
    expect(resolveCapabilities({ CEZ_REMOTE: '1', CEZ_FOLLOWUPS: '1' })).toMatchObject({
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
    });
  });
});
