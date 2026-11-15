import { z } from 'zod';

/**
 * Why the CezarBot shell (PR #1901) says the relay connection is down — it can see the relay, the
 * cockpit cannot. Not an HTTP shape: the shell emits it on the WebView's `window`:
 *
 *   window.dispatchEvent(new CustomEvent('cezar:connection-status', { detail: {
 *     reason: 'peer-offline' | 'relay-unreachable' | 'network-offline' | 'account-blocked' | 'connected',
 *     attempt?: number,      // the shell's reconnect attempt, a non-negative integer
 *     computerName?: string, // the computer it is reaching, shown for 'peer-offline'
 *   } }))
 *
 * A detail that does not parse is ignored; 'connected' clears the reason.
 */
export const NATIVE_CONNECTION_STATUS_EVENT = 'cezar:connection-status';
export const nativeConnectionStatusSchema = z.object({
  reason: z.enum(['peer-offline', 'relay-unreachable', 'network-offline', 'account-blocked', 'connected']),
  attempt: z.number().int().nonnegative().optional(),
  computerName: z.string().trim().min(1).max(200).optional(),
});
export type NativeConnectionStatus = z.infer<typeof nativeConnectionStatusSchema>;
