/**
 * Strips GitHub install/user tokens out of free-form strings before they hit a
 * log sink, the cockpit, or `finalizeRun({ reason })`.
 *
 * `execFile` failures prepend `Command failed: <argv joined>` to `err.message`,
 * and the clone/fetch argv embeds the token in
 * `https://x-access-token:<TOKEN>@github.com/...`. Without this scrub a single
 * transient `git clone` failure would smear a live install token across stderr,
 * `journalctl`, centralized logging, and the cockpit UI. Defense-in-depth on top
 * of keeping the token off argv where possible.
 */
export function redactToken(s: string): string {
  return s
    .replace(/x-access-token:[A-Za-z0-9_.-]+@/g, 'x-access-token:***@')
    .replace(/ghs_[A-Za-z0-9]{20,}/g, 'ghs_***')
    .replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_***');
}
