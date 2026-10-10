/**
 * Path arithmetic for paths the SERVER spelled — POSIX on Linux/macOS, `C:\…` or `\\server\share\…`
 * on Windows. The cockpit cannot ask which platform produced a path, so both separators are honoured.
 */

/** `C:` — a drive letter with nothing after it. On Windows that names the drive's CURRENT directory,
 *  not its root, so it must never be handed back as a parent. Also matches the extended `\\?\C:`. */
const BARE_DRIVE = /^(?:\\\\\?\\)?[A-Za-z]:$/
/** `\\server\share` — the top of a UNC path; there is nothing above it to step back to. */
const UNC_SHARE_ROOT = /^(?:[\\/]{2}(?!\?[\\/])|\\\\\?\\UNC\\)[^\\/]+[\\/][^\\/]+$/i

/** The folder one level up — the same path minus its last segment — or `null` at a filesystem root. */
export function parentDir(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (BARE_DRIVE.test(trimmed) || UNC_SHARE_ROOT.test(trimmed)) return null
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut < 0) return null
  if (cut === 0) return trimmed.slice(0, 1)
  const parent = trimmed.slice(0, cut)
  // `C:\Repos` → `C:\`, keeping the separator the path already used.
  return BARE_DRIVE.test(parent) ? trimmed.slice(0, cut + 1) : parent
}
