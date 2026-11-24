import { describe, expect, it } from 'vitest';
import { defaultComputerName, sanitizeComputerName, trimHostname } from './computer-name.ts';

describe('the computer name (RELAY_PROTOCOL.md § 18 label)', () => {
  it('cleans what the relay refuses: control and bidi-override characters, < and >', () => {
    expect(sanitizeComputerName('  My‮ <Mac>\n\tPro⁦ ')).toBe('My Mac Pro');
    expect(sanitizeComputerName(' \u0000 ')).toBe('');
  });

  it('cuts to 64 UTF-8 bytes without splitting a character', () => {
    const name = sanitizeComputerName('ż'.repeat(40));
    expect(Buffer.byteLength(name, 'utf8')).toBe(64);
    expect(sanitizeComputerName('😀'.repeat(20))).toBe('😀'.repeat(16));
  });

  it('a Mac uses the name its owner gave it, elsewhere the hostname without its domain', () => {
    expect(defaultComputerName('darwin', 'Patryks-MacBook-Pro.local', () => 'Patryk’s MacBook Pro\n')).toBe('Patryk’s MacBook Pro');
    expect(defaultComputerName('darwin', 'Patryks-MacBook-Pro.local', () => undefined)).toBe('Patryks-MacBook-Pro');
    expect(defaultComputerName('linux', 'build-01.example.com')).toBe('build-01');
    expect(defaultComputerName('linux', '')).toBe('Computer');
    expect(trimHostname('.local')).toBe('.local');
  });
});
