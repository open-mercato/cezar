import { z } from 'zod';

/**
 * LAN access (spec `2026-10-20-lan-basic-auth-https`): `GET`/`PUT /api/v1/security/lan`.
 * Off by default. On, the loopback listener stays exactly as it is and a second, HTTPS-only
 * listener opens on this machine's LAN addresses behind HTTP Basic Auth.
 */

/**
 * `available`: false on a hosted cockpit (`CEZ_REMOTE=1`, non-loopback `--bind-host`), whose
 * reverse proxy already owns the perimeter. `editable`: the request came over loopback — LAN
 * clients can read the status but never change it. `active`: the LAN listener is bound right now
 * (`lanAccess` is what was asked for; `error` says why the two differ). `certFingerprint` is the
 * SHA-256 of the self-signed certificate, so the browser's warning can be checked against it.
 */
export const securityLanStatusSchema = z.object({
  available: z.boolean(),
  editable: z.boolean(),
  lanAccess: z.boolean(),
  active: z.boolean(),
  authConfigured: z.boolean(),
  username: z.string().nullable(),
  port: z.number().int(),
  tlsEnabled: z.boolean(),
  lanIp: z.string().nullable(),
  lanUrls: z.array(z.string()),
  certFingerprint: z.string().nullable(),
  error: z.string().nullable(),
});
export type SecurityLanStatus = z.infer<typeof securityLanStatusSchema>;

/** Turning LAN access on needs credentials, given here or kept from an earlier save. A new
 *  `password` always comes with a `username`. */
export const setSecurityLanInputSchema = z
  .object({
    lanAccess: z.boolean(),
    username: z.string().trim().min(1).max(64).regex(/^[^:]+$/, 'username must not contain ":"').optional(),
    password: z.string().min(8).max(128).optional(),
  })
  .refine((input) => input.password === undefined || input.username !== undefined, {
    message: 'a new password needs a username',
  });
export type SetSecurityLanInput = z.infer<typeof setSecurityLanInputSchema>;
