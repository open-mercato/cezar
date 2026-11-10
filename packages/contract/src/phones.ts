import { z } from 'zod';

/** Settings > Connect a phone (spec `.ai/specs/2026-11-01-relay-qr-pairing.md`). */

export const phonePlatformSchema = z.enum(['android', 'ios']);
export type PhonePlatform = z.infer<typeof phonePlatformSchema>;

export const phoneDeviceParamSchema = z.object({ deviceId: z.string().regex(/^[A-Za-z0-9_-]{22}$/) });
export const phonePairingParamSchema = z.object({ id: z.uuid() });

/** `off` means no socket, which is the normal state with no phone paired. */
export const relayStatusSchema = z.enum([
  'off', 'connecting', 'connected', 'unreachable', 'replaced', 'rate-limited', 'quota', 'disabled', 'update-required', 'locked', 'error',
]);
export type RelayStatus = z.infer<typeof relayStatusSchema>;

export const phonePairingStatusSchema = z.enum([
  'waiting', 'handshaking', 'confirm', 'approving', 'approved', 'denied', 'expired', 'cancelled', 'failed',
]);
export type PhonePairingStatus = z.infer<typeof phonePairingStatusSchema>;

export const phonePairingFailureSchema = z.enum([
  'device-limit', 'relay-error', 'timeout', 'cancelled', 'contested', 'bad-payload', 'tunnel-unsupported', 'phone-left',
]);
export type PhonePairingFailure = z.infer<typeof phonePairingFailureSchema>;

/** Never the secret, the code or the QR string: this shape rides SSE and `GET /workspace/phones`. */
export const phonePairingSchema = z.object({
  id: z.string(),
  status: phonePairingStatusSchema,
  expiresAt: z.string(),
  method: z.enum(['qr', 'code']).optional(),
  phone: z.object({ name: z.string(), platform: phonePlatformSchema }).optional(),
  digits: z.string().optional(),
  failure: phonePairingFailureSchema.optional(),
});
export type PhonePairing = z.infer<typeof phonePairingSchema>;

export const phoneSchema = z.object({
  deviceId: z.string(),
  label: z.string(),
  platform: phonePlatformSchema,
  addedAt: z.string(),
  lastSeenAt: z.string().optional(),
  connected: z.boolean(),
  /** The phone handed over a push grant (spec R5). Absent when it has none. */
  push: z.literal(true).optional(),
});
export type Phone = z.infer<typeof phoneSchema>;

/**
 * `GET`, `PUT` and `DELETE /workspace/phone/push`: the calling phone's own push grant, reachable
 * only from inside its relay session (spec 2026-11-01-relay-qr-pairing, R5).
 */
export const phonePushStateSchema = z.object({
  /** False under `CEZ_PUSH=0`: the phone keeps no grant for this server. */
  available: z.boolean(),
  /** cezar's Ed25519 relay key, base64url: `cezarKey` in `POST /v1/push-grants`. Present when available. */
  cezarKey: z.string().optional(),
  /** The grant cezar holds for this phone, if any. */
  grantId: z.string().optional(),
  /** Unix seconds; the phone renews once under 30 days remain. */
  grantExpiresAt: z.number().int().optional(),
  /** The manager the latest push was about, so a tap opens it. An opaque id, never in the push. */
  managerId: z.string().optional(),
});
export type PhonePushState = z.infer<typeof phonePushStateSchema>;

export const setPhonePushGrantInputSchema = z.object({
  grant: z.string().min(1).max(4096),
  grantId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  expiresAt: z.number().int().positive(),
}).strict();
/** `event: signal` on `GET /workspace/phone/signals`: sent instead of a push while that stream is open. */
export const phoneSignalEventSchema = z.object({ managerId: z.string().optional() });
export type PhoneSignalEvent = z.infer<typeof phoneSignalEventSchema>;

export type SetPhonePushGrantInput = z.infer<typeof setPhonePushGrantInputSchema>;

export const phonesResponseSchema = z.object({
  relayOrigin: z.string(),
  relay: z.object({ status: relayStatusSchema, detail: z.string().optional() }),
  phones: z.array(phoneSchema),
  pairing: phonePairingSchema.nullable(),
  /** Grants a `too-many-grants` answer left alive, kept for R5 and shown as a warning. */
  undeniedGrants: z.number().optional(),
});
export type PhonesResponse = z.infer<typeof phonesResponseSchema>;

/** Carries a credential, like the code below. Sent once, `no-store`, and never logged. */
export const startPhonePairingResponseSchema = z.object({
  id: z.string(),
  qr: z.string(),
  relayOrigin: z.string(),
  expiresAt: z.string(),
});
export type StartPhonePairingResponse = z.infer<typeof startPhonePairingResponseSchema>;

/** The typed code, opened only on request so an unused one costs the relay nothing (§ 9.2). */
export const phonePairingCodeResponseSchema = z.object({ code: z.string(), relayOrigin: z.string() });
export type PhonePairingCodeResponse = z.infer<typeof phonePairingCodeResponseSchema>;

export const renamePhoneInputSchema = z.object({ label: z.string().trim().min(1).max(64) }).strict();
export type RenamePhoneInput = z.infer<typeof renamePhoneInputSchema>;

export const phoneOkResponseSchema = z.object({ ok: z.literal(true) });
export type PhoneOkResponse = z.infer<typeof phoneOkResponseSchema>;

/** `phone-pairing` on `/workspace/events`: something on the screen changed. Withheld from a relay scope. */
export const phonePairingEventSchema = z.object({ pairing: phonePairingSchema.nullable() });
export type PhonePairingEvent = z.infer<typeof phonePairingEventSchema>;
