import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { z } from 'zod';
import { SHADOW_INTENT_ID_RE } from '@open-mercato/cezar-contract';
import {
  CAPTURE_MAX_BYTES,
  CAPTURE_MAX_FILES,
  LEDGER_VERSION,
  MAX_ARGV_TOKENS,
  MAX_ARG_CHARS,
  shadowPaths,
  type DecisionLine,
  type IntentLine,
} from './ledger.ts';

/**
 * The server's read of a shadow ledger (spec `2026-10-06-shadow-runs` § Trust).
 *
 * `intents.ndjson` is written by the shim, which runs as the agent: every line is untrusted input.
 * So each one is parsed against a closed, bounded schema; a line that fails is skipped, never
 * fatal (one corrupt line must not hide the rest of the audit trail); and the file is read up to a
 * byte cap, past which the answer says `truncated` instead of growing without bound.
 *
 * What is NOT read from here is any verdict. Intents carry raw argv and ref names only; whether one
 * may be promoted is re-derived by `view.ts` on every read.
 */

export const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
export const MAX_INTENTS = 500;

const intentId = z.string().regex(SHADOW_INTENT_ID_RE);
const sha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const timestamp = z.string().min(1).max(64);

const capturedFileSchema = z.object({
  flag: z.string().min(1).max(64),
  index: z.number().int().min(0).max(1_000),
  inline: z.boolean(),
  name: z.string().max(4_096),
  content: z.string().max(CAPTURE_MAX_BYTES),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const pushLineSchema = z.object({
  v: z.literal(LEDGER_VERSION),
  type: z.literal('intent'),
  id: intentId,
  at: timestamp,
  kind: z.literal('push'),
  remote: z.string().min(1).max(200),
  ref: z.string().min(1).max(1_024),
  sha,
  oldSha: sha,
  pinned: z.boolean(),
});

const forgeLineSchema = z.object({
  v: z.literal(LEDGER_VERSION),
  type: z.literal('intent'),
  id: intentId,
  at: timestamp,
  kind: z.enum(['forge', 'denied']),
  tool: z.literal('gh'),
  // The same bounds the shim cuts to (`ledger.ts`): a recorded intent is never skipped here.
  argv: z.array(z.string().max(MAX_ARG_CHARS)).max(MAX_ARGV_TOKENS),
  cwd: z.string().max(4_096),
  files: z.array(capturedFileSchema).max(CAPTURE_MAX_FILES),
  redacted: z.boolean().optional(),
  truncated: z.boolean().optional(),
});

const intentLineSchema = z.union([pushLineSchema, forgeLineSchema]);

const decisionLineSchema = z.object({
  v: z.literal(LEDGER_VERSION),
  type: z.literal('decision'),
  intentId,
  at: timestamp,
  decision: z.enum(['promoted', 'discarded', 'failed']),
  detail: z.string().max(4_000).optional(),
});

/** Up to `maxBytes` of the file as whole lines; a partial last line is dropped, not parsed. */
function readBoundedLines(path: string, maxBytes: number): { lines: string[]; truncated: boolean } {
  if (!existsSync(path)) return { lines: [], truncated: false };
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, 0);
    const text = buffer.toString('utf8');
    const truncated = size > maxBytes;
    const lines = text.split('\n');
    if (truncated) lines.pop();
    return { lines: lines.filter((line) => line.trim() !== ''), truncated };
  } catch {
    return { lines: [], truncated: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface LedgerSnapshot {
  /** Oldest first, unique by id (the first line with an id wins). */
  intents: IntentLine[];
  /** The decision in force per intent: the last one, except that `promoted` and `discarded` are
   *  final and nothing written after them changes the answer. */
  decisions: Map<string, DecisionLine>;
  truncated: boolean;
}

function parseLine<T>(schema: z.ZodType<T>, line: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function readLedger(dir: string): LedgerSnapshot {
  const paths = shadowPaths(dir);
  const intentRead = readBoundedLines(paths.intents, MAX_LEDGER_BYTES);
  const intents: IntentLine[] = [];
  const seen = new Set<string>();
  let truncated = intentRead.truncated;
  for (const line of intentRead.lines) {
    const intent = parseLine(intentLineSchema, line) as IntentLine | null;
    if (!intent || seen.has(intent.id)) continue;
    if (intents.length >= MAX_INTENTS) {
      truncated = true;
      break;
    }
    seen.add(intent.id);
    intents.push(intent);
  }

  const decisions = new Map<string, DecisionLine>();
  for (const line of readBoundedLines(paths.decisions, MAX_LEDGER_BYTES).lines) {
    const decision = parseLine(decisionLineSchema, line) as DecisionLine | null;
    if (!decision) continue;
    const current = decisions.get(decision.intentId);
    if (current && (current.decision === 'promoted' || current.decision === 'discarded')) continue;
    decisions.set(decision.intentId, decision);
  }
  return { intents, decisions, truncated };
}
