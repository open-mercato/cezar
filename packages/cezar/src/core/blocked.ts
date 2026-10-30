import { z } from 'zod';

/**
 * The external-blocked marker (#1540): a trailing `CEZ:BLOCKED <json>` line by which an agent
 * says "I cannot continue until something outside this session changes". Only this explicit,
 * validated line parks a run as blocked — prose that merely sounds like a blocker never does.
 */
export const BLOCKED_CATEGORIES = ['credential', 'permission', 'environment', 'external-service', 'other'] as const;

const blockedPayloadSchema = z.object({
  category: z.enum(BLOCKED_CATEGORIES),
  resume: z.string().trim().min(1).max(300),
});
export type BlockedSignal = z.infer<typeof blockedPayloadSchema>;

const BLOCKED_LINE_RE = /^CEZ:BLOCKED[ \t]+(\{.*\})$/;

/** Parse the turn's last line (task-reference lines already removed by `turnEndMarkerText`). */
export function parseBlockedMarker(markerText: string): BlockedSignal | null {
  const lastLine = markerText.slice(markerText.lastIndexOf('\n') + 1).trim();
  const match = BLOCKED_LINE_RE.exec(lastLine);
  if (!match) return null;
  try {
    const parsed = blockedPayloadSchema.safeParse(JSON.parse(match[1]!));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Does the turn end on something that merely STARTS like the marker (malformed payload)? */
export function endsWithBlockedKeyword(markerText: string): boolean {
  return /(?:^|\n)[ \t]*CEZ:BLOCKED\b[^\n]*$/.test(markerText);
}

/** Strip a trailing `CEZ:BLOCKED …` line from one text event (same delta caveat as `CEZ:DONE`). */
export function stripBlockedMarker(text: string): string {
  return text.replace(/(?:^|\n)[ \t]*CEZ:BLOCKED[ \t]+\{[^\n]*\}[ \t]*$/, '');
}

/** Normalized key for comparing consecutive replies; digits are dropped so counters don't hide a repeat. */
export function replyKey(text: string): string {
  return text.toLowerCase().replace(/[0-9]+/g, '#').replace(/\s+/g, ' ').trim();
}

/** Token-set Jaccard ≥ 0.9: "near-identical" without caring about punctuation or a changed number. */
export function nearIdenticalReplies(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = new Set(a.split(' '));
  const tb = new Set(b.split(' '));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared) >= 0.9;
}
