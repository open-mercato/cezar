import { z } from 'zod';

/**
 * Why the CezarBot shell (PR #1901) says the relay connection is down: it can see the relay, the
 * cockpit cannot. Server pages have no bridge into the shell, so the shell says it on the wire: its
 * loopback proxy answers a request it cannot deliver with 502 and
 *
 *   X-Cezar-Unreachable: peer-offline | relay-unreachable | network-offline | account-blocked
 *   X-Cezar-Computer: <percent-encoded name of the computer it is reaching> (optional)
 *
 * A value that does not parse is ignored; any answer that is not one of these clears the reason.
 */
export const CEZAR_UNREACHABLE_HEADER = 'X-Cezar-Unreachable';
export const CEZAR_COMPUTER_HEADER = 'X-Cezar-Computer';
export const nativeConnectionStatusSchema = z.object({
  reason: z.enum(['peer-offline', 'relay-unreachable', 'network-offline', 'account-blocked']),
  attempt: z.number().int().nonnegative().optional(),
  computerName: z.string().trim().min(1).max(200).optional(),
});
export type NativeConnectionStatus = z.infer<typeof nativeConnectionStatusSchema>;
