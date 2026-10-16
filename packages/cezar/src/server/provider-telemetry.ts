import type { InconclusiveProbe, ProviderId } from '../core/provider-auth.ts';
import { reportError, telemetryEnabled, track } from '../telemetry.ts';

/**
 * Telemetry for agent sign-in (telemetry `abf08514`): why a status probe could not decide, what
 * Connect did, and whether the login it opened finished. Labels and context are closed sets —
 * never CLI output, paths or account ids (docs/telemetry.md).
 */

/** One error group per provider and reason: an unparseable vendor format is a parser to fix. */
export async function reportInconclusiveProbe(probe: InconclusiveProbe): Promise<void> {
  if (!telemetryEnabled()) return;
  const cliVersion = await probe.cliVersion().catch(() => null);
  const error = new Error(`${probe.provider} authentication status could not be read (${probe.reason})`);
  error.name = 'ProviderAuthProbeInconclusive';
  reportError(
    error,
    {
      'provider.id': probe.provider,
      'provider.cli_version': cliVersion,
      'probe.reason': probe.reason,
      'probe.profile': probe.profile,
      'probe.bin_source': probe.binSource,
      'probe.bin_ext': probe.binExt,
      'probe.error_code': probe.errorCode,
      'probe.exit_code': probe.exitCode,
      'probe.stdout_bytes': probe.stdoutBytes,
      'probe.stdout_json': probe.stdoutJson,
      'probe.stderr_bytes': probe.stderrBytes,
    },
    {
      code: `provider_auth_${probe.reason}`,
      fingerprint: `provider-auth:${probe.provider}:${probe.reason}`,
    },
  );
}

export type ConnectPriorStatus = 'disconnected' | 'unknown';
export type ConnectNotOpenedReason =
  | 'already_connected'
  | 'not_installed'
  | 'invalid_folder'
  | 'hosted'
  | 'no_terminal';

export function trackLoginOpened(provider: ProviderId, prior: ConnectPriorStatus, sid?: string): void {
  track('provider_login_opened', { label: `${provider}:${prior}` }, { sid });
}

export function trackLoginNotOpened(provider: ProviderId, reason: ConnectNotOpenedReason, sid?: string): void {
  track('provider_login_not_opened', { label: `${provider}:${reason}` }, { sid });
}

export type UpdateOutcome = 'opened' | 'unsupported' | 'hosted' | 'no_terminal';

/** What an agent's **Update** (offered next to an outdated-CLI error) did. */
export function trackUpdateOpened(provider: ProviderId, outcome: UpdateOutcome, sid?: string): void {
  track('provider_update_opened', { label: `${provider}:${outcome}` }, { sid });
}

/**
 * When to re-check after Connect opened a login, as offsets from the open. Nothing else re-probes
 * on its own — the cockpit does not poll provider status — so without these a finished login is
 * invisible until someone presses "Check again". Seven probes at most, all within 15 minutes.
 */
export const LOGIN_WATCH_OFFSETS_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000];

/**
 * Re-check one login on {@link LOGIN_WATCH_OFFSETS_MS} until it reports connected, then call
 * `onConnected` once. Returns a cancel. A failed check counts as "not yet".
 */
export function watchLogin(
  check: () => Promise<boolean>,
  onConnected: () => void,
  offsets: readonly number[] = LOGIN_WATCH_OFFSETS_MS,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let step = 0;
  let elapsed = 0;
  const schedule = () => {
    if (cancelled || step >= offsets.length) return;
    const offset = offsets[step++]!;
    timer = setTimeout(() => {
      void check().catch(() => false).then((connected) => {
        if (cancelled) return;
        if (connected) {
          cancelled = true;
          onConnected();
          return;
        }
        schedule();
      });
    }, Math.max(0, offset - elapsed));
    elapsed = offset;
    timer.unref?.();
  };
  schedule();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
