import { processIdentityPlatformSupported } from '../runtime/process-identity.ts';

/** Whether verified process ownership is available for webhook delivery on this host. */
export const webhookPlatformSupported = processIdentityPlatformSupported;

export const WEBHOOK_UNSUPPORTED_PLATFORM_MESSAGE =
  'Webhooks are unsupported on this platform. Delivery requires an OS-verified process identity (Linux /proc, macOS ps/sysctl or Windows PowerShell).';
