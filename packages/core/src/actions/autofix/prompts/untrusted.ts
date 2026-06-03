// Helpers for safely embedding attacker-controlled GitHub content (issue
// titles/bodies, comment text, comment author handles) into agent prompts and
// git-visible artifacts. Autofix runs against public-issue repos where anyone
// can open or edit an issue, so every one of these fields is untrusted input.

/**
 * Phase markers (`## PHASE: <NAME>`) drive the unified-session prompt's role
 * transitions. If an untrusted block contains one verbatim, the model could be
 * tricked into switching phases or skipping review. Neutralize any such marker
 * so it reads as plain text instead of a control line.
 */
export function stripPhaseMarkers(text: string): string {
  return text.replace(/^(\s*)##\s*PHASE:/gim, '$1## (phase-marker stripped):');
}

/**
 * Fence an untrusted block between a sentinel the model is told to treat as
 * data only. Strips phase markers first, then defangs any literal occurrence of
 * the sentinel inside the payload so the attacker can't forge an early `<<<END
 * <name>>>>` to break out of the fence.
 */
export function fenceUntrusted(name: string, text: string): string {
  const open = `<<<BEGIN ${name}>>>`;
  const close = `<<<END ${name}>>>`;
  const safe = stripPhaseMarkers(text)
    .replaceAll(open, '<<<ESCAPED>>>')
    .replaceAll(close, '<<<ESCAPED>>>');
  return `${open}\n${safe}\n${close}`;
}

/**
 * Normalize a GitHub-supplied title for a single-line git surface (commit
 * subject, PR title). Collapses all whitespace (newlines included — a newline
 * in a title would otherwise split the commit subject from its body) and caps
 * length so the subject stays within conventional limits.
 */
export function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, 72);
}
