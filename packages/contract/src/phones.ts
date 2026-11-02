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

/** Where `relayOrigin` came from. `env-invalid` is a set `CEZ_RELAY_URL` that § 9.1 refuses. */
export const relayAddressSourceSchema = z.enum(['env', 'env-invalid', 'settings', 'default', 'none']);
export type RelayAddressSource = z.infer<typeof relayAddressSourceSchema>;

export const phonesResponseSchema = z.object({
  /** Empty with no usable address, which `relaySource` explains. */
  relayOrigin: z.string(),
  relaySource: relayAddressSourceSchema,
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

const relayAddressSchema = z.string().trim().min(1).max(300);

/** `null` clears it. `dropPhones` is the user's answer to the warning: without it, paired phones refuse the change. */
export const setRelayAddressInputSchema = z.object({
  address: relayAddressSchema.nullable(),
  dropPhones: z.boolean().optional(),
}).strict();
export type SetRelayAddressInput = z.infer<typeof setRelayAddressInputSchema>;

export const testRelayAddressInputSchema = z.object({ address: relayAddressSchema }).strict();
export type TestRelayAddressInput = z.infer<typeof testRelayAddressInputSchema>;

export const relayTestFailureSchema = z.enum([
  'invalid-address', 'unreachable', 'not-a-relay', 'incompatible', 'rate-limited', 'disabled', 'refused',
]);
export type RelayTestFailure = z.infer<typeof relayTestFailureSchema>;

export const testRelayAddressResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), origin: z.string(), protocol: z.number() }),
  z.object({ ok: z.literal(false), reason: relayTestFailureSchema }),
]);
export type TestRelayAddressResponse = z.infer<typeof testRelayAddressResponseSchema>;

export const phoneOkResponseSchema = z.object({ ok: z.literal(true) });
export type PhoneOkResponse = z.infer<typeof phoneOkResponseSchema>;

/** `phone-pairing` on `/workspace/events`: something on the screen changed. Withheld from a relay scope. */
export const phonePairingEventSchema = z.object({ pairing: phonePairingSchema.nullable() });
export type PhonePairingEvent = z.infer<typeof phonePairingEventSchema>;
