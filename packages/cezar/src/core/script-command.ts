/**
 * The command that actually runs `bin`. A JavaScript file is executable on POSIX by its shebang
 * and not at all on Windows, where spawning one fails with `EFTYPE` — which is what every bundled
 * mock is, so `CEZ_DRY_RUN=1` could not start a single session there. On Windows a script is
 * therefore handed to this process's own Node. Every other platform, and every real binary, is
 * returned untouched.
 */
export function scriptAwareCommand(bin: string, args: readonly string[], platform: NodeJS.Platform = process.platform): [string, string[]] {
  return platform === 'win32' && /\.(mjs|cjs|js)$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, [...args]];
}
