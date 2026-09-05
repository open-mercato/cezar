import { z } from 'zod';

import { attachmentInputSchema } from './runs.ts';

/**
 * Per-run, per-surface DRAFTS — the unsent text (and pasted screenshots) of every editable input
 * inside a task (spec `.ai/specs/2026-08-30-thread-composer-draft-persistence.md`, #939).
 *
 * Server-side by decision, not by habit: a draft has to follow the user across browsers, survive a
 * reload and survive a `cez` restart, which rules out the localStorage stores `/new`
 * (`new-task-draft.ts`) and the GitHub hand-off box (`hand-to-agent-draft.ts`) use. It also has its
 * own route family and its own files under `.ai/cezar/drafts/` rather than a key in
 * `ui-state.json`: that file's PUT is capped at 128 KiB, merges shallowly, and is read whole on
 * every cockpit load — none of which survives contact with a 20 MB attachment draft.
 */

/** The text cap, shared with `PATCH /runs/:id`'s `task`. */
export const DRAFT_TEXT_MAX = 100_000;

/** Attachments per surface — composer parity (`MAX_ATTACHMENTS`). */
export const DRAFT_MAX_IMAGES = 4;

/** Surfaces per run. A task has five editable inputs plus one editor per queued message; 16 is
 *  well past any real task and keeps one run's draft file bounded. */
export const DRAFT_MAX_SURFACES = 16;

/**
 * Which inputs may hold a draft.
 *
 * VALIDATED, never interpolated: a surface id reaches the filesystem as a path segment, so an
 * unchecked value is a traversal. `message:<id>` is the one parameterized member — a task can have
 * several queued messages, each with its own inline editor.
 */
export const DRAFT_SURFACE_RE = /^(composer|review-notes|task-prompt|title|message:[A-Za-z0-9_-]{1,64})$/;

export const draftSurfaceSchema = z
  .string()
  .regex(DRAFT_SURFACE_RE, 'unknown draft surface');
export type DraftSurface = z.infer<typeof draftSurfaceSchema>;

/** Ids are server-minted; the pattern is what keeps them safe as a path segment. */
export const DRAFT_IMAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** One attachment held by a draft — the metadata, never the bytes. The bytes come from
 *  `GET …/images/:imageId`, so a draft listing stays small however many screenshots it holds. */
export const draftImageSchema = z.object({
  id: z.string(),
  /** `image/png`, `image/jpeg`, … — whatever the composer screened and sent. */
  mediaType: z.string(),
  /** The composer's thumbnail label (the pasted file's name). */
  name: z.string(),
  /** Decoded size. Informational — the caps are enforced on the way in. */
  bytes: z.number(),
});
export type DraftImage = z.infer<typeof draftImageSchema>;

/** One surface's unsent content. */
export const draftEntrySchema = z.object({
  text: z.string(),
  images: z.array(draftImageSchema),
  /** ISO. The backstop's eviction order, and nothing else — drafts never expire by age. */
  updatedAt: z.string(),
});
export type DraftEntry = z.infer<typeof draftEntrySchema>;

/** `GET /runs/:id/drafts` — every surface of one run that holds something. */
export const runDraftsResponseSchema = z.object({
  surfaces: z.record(z.string(), draftEntrySchema),
});
export type RunDraftsResponse = z.infer<typeof runDraftsResponseSchema>;

/**
 * `PUT /runs/:id/drafts/:surface` — the whole surface, replaced.
 *
 * `images` carries the server-minted IDS of images already uploaded through
 * `POST …/drafts/:surface/images`, never bytes: an attachment is uploaded once, when it is
 * attached (the Slack move), and the draft record only references it.
 *
 * An empty write (`{ text: '', images: [] }`) DELETES the entry. "Cleared when emptied" is the
 * user-facing policy, so it is enforced here rather than left to client politeness.
 */
export const setRunDraftInputSchema = z.object({
  text: z.string().max(DRAFT_TEXT_MAX, `must be at most ${DRAFT_TEXT_MAX} characters`).default(''),
  images: z.array(z.string().regex(DRAFT_IMAGE_ID_RE, 'invalid image id')).max(DRAFT_MAX_IMAGES).default([]),
});
export type SetRunDraftInput = z.input<typeof setRunDraftInputSchema>;

/**
 * `POST /runs/:id/drafts/:surface/images` — one attachment, base64, on the same terms as a live
 * message's (`imageInputSchema`, ≤4 per surface, ~5 MB decoded each). `name` is the composer's
 * thumbnail label; an omitted one degrades to a generic label rather than failing an upload.
 */
export const draftImageInputSchema = attachmentInputSchema.extend({
  name: z.string().trim().max(200).default('image'),
});
export type DraftImageInput = z.input<typeof draftImageInputSchema>;

/** `GET /runs/:id/drafts/:surface/images/:imageId` — the bytes, base64.
 *
 *  JSON rather than raw bytes because the composer's `PendingAttachment` is base64 either way,
 *  and every response shape in this repo is a zod schema. */
export const draftImageContentSchema = draftImageSchema.extend({
  data: z.string(),
});
export type DraftImageContent = z.infer<typeof draftImageContentSchema>;

/** Path params of the per-surface routes. The surface is validated HERE, as route middleware, for
 *  the same reason every other body is: a handler-side check is invisible to hono's route type,
 *  and this one is also the traversal guard. */
export const draftSurfaceParamSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  surface: draftSurfaceSchema,
});
export type DraftSurfaceParam = z.infer<typeof draftSurfaceParamSchema>;

/** …and of the blob routes under it. */
export const draftImageParamSchema = draftSurfaceParamSchema.extend({
  imageId: z.string().regex(DRAFT_IMAGE_ID_RE, 'invalid image id'),
});
export type DraftImageParam = z.infer<typeof draftImageParamSchema>;

/** `DELETE /runs/:id/drafts/:surface` and `DELETE …/images/:imageId`. Idempotent for a known run:
 *  deleting a draft that was never written is still "there is no draft here". */
export const deleteDraftResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteDraftResponse = z.infer<typeof deleteDraftResponseSchema>;
