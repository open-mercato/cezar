import { z } from 'zod';
import { runIdParamSchema } from './events.ts';

/**
 * The SHADOW family of `/api/v1` (spec `.ai/specs/2026-10-06-shadow-runs.md`): what a shadow run
 * tried to do OUTSIDE its worktree, and the human decision on each attempt.
 *
 * A shadow run is an ordinary task with one property: its outward side effects are captured
 * instead of executed. `git push` lands in a local shadow remote whose hook records the ref update
 * and rejects it, and a `gh` command that would change GitHub prints a "recorded" notice instead of
 * running. Each captured attempt is an INTENT; a human promotes it (cezar executes it with the
 * user's own credentials), discards it, or runs it by hand.
 *
 * Every shape here is SERVER-DERIVED. The ledger on disk is written by processes the agent
 * controls, so the server re-classifies each entry from its raw argv/ref on every read and never
 * trusts a stored verdict. That is why `promotable` and `reason` live on the wire and not in the
 * ledger.
 */

/** `<base36 epoch ms>-<6 hex>`, minted by the shim and re-validated on every read. */
export const SHADOW_INTENT_ID_RE = /^[0-9a-z]{6,12}-[0-9a-f]{6}$/;
export const shadowIntentIdSchema = z.string().regex(SHADOW_INTENT_ID_RE);

/** `:id` + `:intentId` for the two decision routes - both path segments, both validated as
 *  middleware before anything touches the filesystem. */
export const shadowIntentParamSchema = runIdParamSchema.extend({ intentId: shadowIntentIdSchema });
export type ShadowIntentParam = z.infer<typeof shadowIntentParamSchema>;

/**
 * What kind of attempt this was.
 *  - `push`: a `git push` (any git process in the run's tree) that the shadow remote recorded.
 *  - `forge`: a `gh` command classified as a write.
 *  - `denied`: a `gh` command that touches credentials or the user's own gh setup (`auth token`,
 *    `secret set`, `extension install`). Recorded for the audit trail, never promotable.
 */
export const shadowIntentKindSchema = z.enum(['push', 'forge', 'denied']);
export type ShadowIntentKind = z.infer<typeof shadowIntentKindSchema>;

/**
 * Who may execute an intent.
 *  - `click`: cezar runs it after a single confirmation (a new branch, a fast-forward, a PR,
 *    a comment).
 *  - `manual`: cezar never runs it; the cockpit shows the exact command to run by hand (a merge, an
 *    approval, a force push, anything under `gh api`, an unknown command).
 *  - `never`: nothing to run (a denied attempt, a deleted ref).
 */
export const shadowPromotableSchema = z.enum(['click', 'manual', 'never']);
export type ShadowPromotable = z.infer<typeof shadowPromotableSchema>;

/** `failed` is a promotion that ran and did not succeed. It stays promotable, so a transient
 *  network error can be retried; `promoted` and `discarded` are final. */
export const shadowIntentStateSchema = z.enum(['pending', 'promoted', 'discarded', 'failed']);
export type ShadowIntentState = z.infer<typeof shadowIntentStateSchema>;

/** How a recorded push relates to the remote-tracking ref as this machine last fetched it - never
 *  a network call, so "new" can mean "new since the last fetch". */
export const shadowPushRelationSchema = z.enum(['new', 'fast-forward', 'diverged', 'delete', 'unknown']);
export type ShadowPushRelation = z.infer<typeof shadowPushRelationSchema>;

export const shadowPushSchema = z.object({
  remote: z.string(),
  ref: z.string(),
  sha: z.string(),
  relation: shadowPushRelationSchema,
  /** The commit is pinned under `refs/cezar/shadow/<runId>/` so `git gc` cannot collect it
   *  before a human decides. `false` means the objects were never in this repository (a push
   *  from a separate clone) - such an intent can only be run by hand. */
  pinned: z.boolean(),
});
export type ShadowPush = z.infer<typeof shadowPushSchema>;

/** A file a `gh` write referenced (`--body-file`, `-F`), captured at record time so the intent
 *  can still be promoted after the agent's temp directory is gone. Content stays server-side. */
export const shadowForgeFileSchema = z.object({
  flag: z.string(),
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  /** The first characters of what promoting would post, secrets redacted. A reviewer approves
   *  content, not a file name: `--body-file ~/.ssh/id_rsa` must be visible as what it is. */
  preview: z.string(),
});
export type ShadowForgeFile = z.infer<typeof shadowForgeFileSchema>;

export const shadowForgeSchema = z.object({
  tool: z.literal('gh'),
  argv: z.array(z.string()),
  /** The `owner/repo` an explicit `-R/--repo` names - shown next to the command, because a
   *  write aimed at ANOTHER repository is the one thing a reviewer must not miss. */
  repo: z.string().optional(),
  files: z.array(shadowForgeFileSchema),
});
export type ShadowForge = z.infer<typeof shadowForgeSchema>;

export const shadowIntentSchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: shadowIntentKindSchema,
  /** One human line: `push cez/1a2b3c4d to origin (fast-forward)`, `gh pr create "Fix login"`. */
  summary: z.string(),
  /** The exact command a human would type to do it by hand, POSIX-quoted. */
  command: z.string(),
  promotable: shadowPromotableSchema,
  /** Why it got that class - the policy row, in words. */
  reason: z.string(),
  state: shadowIntentStateSchema,
  decidedAt: z.string().optional(),
  /** The promotion's output (first lines) or why it failed. */
  detail: z.string().optional(),
  push: shadowPushSchema.optional(),
  forge: shadowForgeSchema.optional(),
});
export type ShadowIntent = z.infer<typeof shadowIntentSchema>;

/**
 * `GET /runs/:id/shadow`. Answers for EVERY run, shadow or not: an ordinary run is
 * `{ shadow: false, intents: [], truncated: false }`, so a client never needs a second request to
 * learn which kind it is looking at.
 */
export const shadowLedgerResponseSchema = z.object({
  shadow: z.boolean(),
  intents: z.array(shadowIntentSchema),
  /** The ledger held more than the read cap; `intents` is the oldest slice. */
  truncated: z.boolean(),
});
export type ShadowLedgerResponse = z.infer<typeof shadowLedgerResponseSchema>;

/** `POST /runs/:id/shadow/intents/:intentId/promote` - 409 on every refusal (not a shadow run,
 *  manual or never class, already decided, a pending push ahead of a PR) and on an execution
 *  failure, whose `ApiError` carries the `manual` command. */
export const shadowPromoteResponseSchema = z.object({
  promoted: z.literal(true),
  intent: shadowIntentSchema,
});
export type ShadowPromoteResponse = z.infer<typeof shadowPromoteResponseSchema>;

/** `POST /runs/:id/shadow/intents/:intentId/discard` - 409 when already decided. */
export const shadowDiscardResponseSchema = z.object({
  discarded: z.literal(true),
  intent: shadowIntentSchema,
});
export type ShadowDiscardResponse = z.infer<typeof shadowDiscardResponseSchema>;
