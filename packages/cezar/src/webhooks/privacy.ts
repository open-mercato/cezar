import type { WebhookSource } from './source.ts';

// Telemetry only substitutes known runtime roots. Webhooks can contain paths from
// another machine, so remove syntactic paths, including their private suffixes.
// HTTP(S) prose links are kept; dedicated link fields retain their own validation.
const pathStart = String.raw`(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|~[A-Za-z0-9_.-]*[\\/]|\.{1,2}[\\/]|\/)`;
// Unquoted paths can contain spaces or apostrophes. Their end is ambiguous:
// discard the rest of that text line instead of exposing a private suffix.
const localPath = new RegExp(String.raw`(?<![\w/\\])(?:(["'\x60])${pathStart}[^\r\n]*?\1|${pathStart}(?=\S)[^\r\n]+)`, 'gi');

export function scrubWebhookText(text: string): string {
  // Split instead of placeholders: user text cannot collide with a sentinel.
  // Receiver URLs may contain quotes or angle brackets. Preserve the complete
  // non-whitespace URL token so later secret redaction can still match it.
  return text.split(/(https?:\/\/\S+)/gi).map((part, index) => {
    if (index % 2) {
      try { if (new URL(part).hostname) return part; } catch { /* scrub malformed URLs as text */ }
    }
    // One character keeps even a path-only label nonempty without growing bounds.
    return part.replace(localPath, match => `…${/[.,;:!?\])}]+$/.exec(match)?.[0] ?? ''}`);
  }).join('');
}

/** Copy only free-text leaves; never alter identities, timestamps or link fields. */
export function scrubWebhookSource(source: WebhookSource): WebhookSource {
  const snapshot = source.snapshot;
  return { ...source, snapshot: {
    ...snapshot,
    ...(snapshot.title !== undefined ? { title: scrubWebhookText(snapshot.title) } : {}),
    ...(snapshot.error !== undefined ? { error: scrubWebhookText(snapshot.error) } : {}),
    ...(snapshot.attentionRequest ? { attentionRequest: {
      ...snapshot.attentionRequest,
      questions: snapshot.attentionRequest.questions.map(question => ({
        ...question, question: scrubWebhookText(question.question),
        ...(question.options ? { options: question.options.map(option => ({
          ...option, label: scrubWebhookText(option.label),
          ...(option.description !== undefined ? { description: scrubWebhookText(option.description) } : {}),
        })) } : {}),
      })),
    } } : {}),
  } };
}
