/**
 * Whether verified process ownership is available here.
 *
 * Linux (`/proc`), macOS (`ps`/`sysctl`) and Windows (PowerShell) all expose an OS-verified
 * process start token and boot identity — see `process-identity.ts`. Anything else fails
 * closed: the platform is reported unsupported rather than emulating ownership.
 */
export function webhookPlatformSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux' || platform === 'darwin' || platform === 'win32';
}

export const WEBHOOK_UNSUPPORTED_PLATFORM_MESSAGE =
  'Webhooks are unsupported on this platform. Delivery requires an OS-verified process identity (Linux /proc, macOS ps/sysctl or Windows PowerShell).';
