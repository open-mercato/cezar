/**
 * Reject option-like git revision arguments (#431). A `-`/`--`-prefixed
 * base/from ref is git argument injection: `git diff --output=/path` writes an
 * arbitrary file, `--upload-pack=<cmd>` runs a command, etc. Every ref cezar
 * feeds to git is already gated upstream by `git rev-parse --verify` /
 * `git check-ref-format`, which reject option-like values — this is the
 * explicit last line of defense so a future refactor can't silently drop that
 * gate. Empty refs are rejected too: git would resolve them to an unexpected
 * default rather than the intended revision.
 */
export function isSafeGitRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith('-');
}
