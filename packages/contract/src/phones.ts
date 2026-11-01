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
});
export type Phone = z.infer<typeof phoneSchema>;

export const phonesResponseSchema = z.object({
  relayOrigin: z.string(),
  relay: z.object({ status: relayStatusSchema, detail: z.string().optional() }),
  phones: z.array(phoneSchema),
  pairing: phonePairingSchema.nullable(),
  /** Grants a `too-many-grants` answer left alive, kept for R5 and shown as a warning. */
  undeniedGrants: z.number().optional(),
});
export type PhonesResponse = z.infer<typeof phonesResponseSchema>;

/** The only shape that carries the credentials. Sent once, `no-store`, and never logged. */
export const startPhonePairingResponseSchema = z.object({
  id: z.string(),
  qr: z.string(),
  code: z.string().nullable(),
  relayOrigin: z.string(),
  expiresAt: z.string(),
});
export type StartPhonePairingResponse = z.infer<typeof startPhonePairingResponseSchema>;

export const renamePhoneInputSchema = z.object({ label: z.string().trim().min(1).max(64) }).strict();
export type RenamePhoneInput = z.infer<typeof renamePhoneInputSchema>;

export const phoneOkResponseSchema = z.object({ ok: z.literal(true) });
export type PhoneOkResponse = z.infer<typeof phoneOkResponseSchema>;

/** `phone-pairing` on `/workspace/events`: something on the screen changed. Withheld from a relay scope. */
export const phonePairingEventSchema = z.object({ pairing: phonePairingSchema.nullable() });
export type PhonePairingEvent = z.infer<typeof phonePairingEventSchema>;
