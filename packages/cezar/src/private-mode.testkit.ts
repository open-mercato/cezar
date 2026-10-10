import { statSync } from 'node:fs';
import { expect } from 'vitest';

/**
 * Assert a file is owner-only (`0600`) — on the platforms that HAVE owner bits.
 *
 * Windows has no POSIX modes: `chmod` can only toggle read-only, and `stat().mode` answers `0666`
 * for every writable file whatever was asked for, so the number says nothing there (privacy on
 * Windows is the ACL the file inherits from the user's profile). The check is therefore gated on
 * the platform and not on a probe of the filesystem: on Linux and macOS it must stay
 * unconditional, or a filesystem quirk could switch off the very assertion that catches a
 * world-readable credentials file.
 */
export function expectOwnerOnlyMode(path: string): void {
  if (process.platform === 'win32') return;
  expect(statSync(path).mode & 0o777).toBe(0o600);
}
