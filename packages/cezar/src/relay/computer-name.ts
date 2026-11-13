import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';

/**
 * The computer's name, sent as the relay account's `label` and shown to a phone while pairing
 * (RELAY_PROTOCOL.md § 18). The relay refuses more than 64 UTF-8 bytes, control and bidi-override
 * characters, `<` and `>`, so everything that leaves here is cleaned first.
 */

export const COMPUTER_NAME_BYTES = 64;
const FORBIDDEN = /[\p{Cc}<>‪-‮⁦-⁩]/gu;

/** Trimmed, cleaned and cut to 64 bytes on a code point boundary. Empty means none. */
export function sanitizeComputerName(text: string): string {
  const cleaned = text.replace(FORBIDDEN, ' ').replace(/\s+/gu, ' ').trim();
  let out = '';
  for (const char of cleaned) {
    if (Buffer.byteLength(out + char, 'utf8') > COMPUTER_NAME_BYTES) break;
    out += char;
  }
  return out.trim();
}

/** `Patryks-MacBook-Pro.local` → `Patryks-MacBook-Pro`: the domain part names the network, not the computer. */
export function trimHostname(host: string): string {
  const first = host.trim().split('.')[0] ?? '';
  return first || host.trim();
}

/**
 * macOS keeps the name the user gave the Mac (`Patryk’s MacBook Pro`) beside the hostname, which
 * loses the apostrophe and spaces; guessing them back is unreliable, so elsewhere the hostname stays.
 */
export function defaultComputerName(platform: NodeJS.Platform = process.platform, host: string = hostname(), macName: () => string | undefined = readMacComputerName): string {
  const pretty = platform === 'darwin' ? sanitizeComputerName(macName() ?? '') : '';
  return pretty || sanitizeComputerName(trimHostname(host)) || 'Computer';
}

function readMacComputerName(): string | undefined {
  try {
    return execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}
