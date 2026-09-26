import { describe, expect, it } from 'vitest';
import {
  cockpitAccessWarnings,
  printCockpitQr,
  printPrivateFrontBanner,
  qrLines,
  qrTargetUrl,
} from './qr.ts';

describe('terminal QR for the cockpit address', () => {
  it('renders a square block string with a quiet zone', () => {
    const lines = qrLines('http://host.ts.net:8445/');
    expect(lines.length).toBeGreaterThan(8);
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
    expect(lines.join('\n')).toMatch(/[█▀▄]/);
  });

  it('prefers CEZ_PUBLIC_URL, then a non-loopback bind, and nothing for loopback', () => {
    expect(
      qrTargetUrl({ publicUrl: 'https://host.ts.net:8445/', bindHost: '127.0.0.1', port: 4321 }),
    ).toBe('https://host.ts.net:8445/');
    expect(qrTargetUrl({ bindHost: '203.0.113.10', port: 4321 })).toBe('http://203.0.113.10:4321');
    expect(qrTargetUrl({ bindHost: '127.0.0.1', port: 4321 })).toBeNull();
    expect(qrTargetUrl({ bindHost: 'LOCALHOST', port: 4321 })).toBeNull();
    expect(qrTargetUrl({ bindHost: '0:0:0:0:0:0:0:1', port: 4321 })).toBeNull();
    expect(qrTargetUrl({ bindHost: '0.0.0.0', port: 4321 })).toBeNull();
    expect(qrTargetUrl({ bindHost: '::', port: 4321 })).toBeNull();
    expect(qrTargetUrl({ bindHost: 'fd7a::1', port: 4321 })).toBe('http://[fd7a::1]:4321');
    expect(qrTargetUrl({ bindHost: '[fd7a::1]', port: 4321 })).toBe('http://[fd7a::1]:4321');
    expect(qrTargetUrl({ port: 4321 })).toBeNull();
  });

  it('survives a payload the encoder refuses instead of taking the cockpit down', () => {
    const lines: string[] = [];
    const huge = `https://host.ts.net:8445/${'x'.repeat(4000)}`;
    expect(printCockpitQr({ publicUrl: huge, port: 4321, env: {}, log: (line) => lines.push(line) })).toBe(huge);
    expect(lines.some((line) => line.includes('QR skipped'))).toBe(true);
  });

  it('prints an explicit CEZ_PUBLIC_URL anywhere, an inferred target only on a TTY, and honours CEZ_NO_QR / CI', () => {
    const lines: string[] = [];
    const base = { publicUrl: 'https://host.ts.net:8445/', port: 4321, log: (line: string) => lines.push(line) };
    expect(printCockpitQr({ ...base, tty: true, env: {} })).toBe('https://host.ts.net:8445/');
    expect(lines.length).toBeGreaterThan(10);
    lines.length = 0;
    // An explicit public URL is an instruction: it prints even without a TTY (captured logs, --no-open).
    expect(printCockpitQr({ ...base, tty: false, env: {} })).toBe('https://host.ts.net:8445/');
    lines.length = 0;
    // An inferred target (non-loopback --bind-host) still needs the interactive check.
    expect(printCockpitQr({ bindHost: '203.0.113.10', port: 4321, tty: false, env: {}, log: (line: string) => lines.push(line) })).toBeNull();
    expect(printCockpitQr({ ...base, tty: true, env: { CEZ_NO_QR: '1' } })).toBeNull();
    expect(printCockpitQr({ ...base, tty: true, env: { CI: 'true' } })).toBeNull();
    expect(lines.length).toBe(0);
  });

  it('warns when the QR target is not trusted, and about what a trusted authority reaches', () => {
    const trusted = new Set(['host.ts.net:8445']);
    expect(
      cockpitAccessWarnings({ publicUrl: 'https://host.ts.net:8445/', trusted, hosted: false }).length,
    ).toBe(1); // only the "what it reaches" warning
    const mismatch = cockpitAccessWarnings({ publicUrl: 'https://other.ts.net:8445/', trusted, hosted: false });
    expect(mismatch[0]).toContain('not in CEZ_TRUSTED_HOSTS');
    expect(cockpitAccessWarnings({ publicUrl: 'not a url', trusted, hosted: false })[0]).toContain('not in CEZ_TRUSTED_HOSTS');
    // A loopback public URL is exactly what the guard admits: no false warning.
    expect(cockpitAccessWarnings({ publicUrl: 'http://localhost:4321/', trusted: new Set(), hosted: false })).toEqual([]);
    expect(cockpitAccessWarnings({ publicUrl: 'http://127.0.0.1:4321/', trusted: new Set(), hosted: false })).toEqual([]);
    // Hosted mode already admits any Host, and local handoff is off there: no warnings.
    expect(cockpitAccessWarnings({ publicUrl: 'https://other.ts.net/', trusted, hosted: true })).toEqual([]);
  });

  it('defaults the TTY check to the real stdout, so the call site cannot forget it', () => {
    const lines: string[] = [];
    const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      expect(
        printCockpitQr({ bindHost: '203.0.113.10', port: 4321, env: {}, log: (line) => lines.push(line) }),
      ).toBe('http://203.0.113.10:4321');
    } finally {
      if (original) Object.defineProperty(process.stdout, 'isTTY', original);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
    expect(lines.length).toBeGreaterThan(10);
  });

  it('drives the whole private-front banner block in one call — the wiring, not just the parts', () => {
    const lines: string[] = [];
    const result = printPrivateFrontBanner({
      publicUrl: 'https://host.ts.net:8445/',
      port: 4321,
      trusted: new Set(['host.ts.net:8445']),
      hosted: false,
      env: {},
      log: (line) => lines.push(line),
    });
    expect(result.printedQr).toBe('https://host.ts.net:8445/');
    expect(lines.some((line) => line.includes('trusted hosts (CEZ_TRUSTED_HOSTS)'))).toBe(true);
    expect(lines.some((line) => /[█▀▄]/.test(line))).toBe(true);
    // The one warning left in this configuration is the reach of a trusted authority.
    expect(result.warnings.length).toBe(1);
    expect(lines.some((line) => line.includes('agent-config editing'))).toBe(true);
  });
});
