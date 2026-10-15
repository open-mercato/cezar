import { macosxCaddy } from './platforms/macosx-caddy.ts';
import { macosxCloudflareTunnel } from './platforms/macosx-cloudflare-tunnel.ts';
import { macosxExternalProxy } from './platforms/macosx-external-proxy.ts';
import { macosxNgrok } from './platforms/macosx-ngrok.ts';
import { macosxTailscale } from './platforms/macosx-tailscale.ts';
import { ubuntuVps } from './platforms/ubuntu-vps.ts';
import { PLATFORM_IDS, type PlatformId, type PlatformStrategy } from './types.ts';

/**
 * Platform registry. `--platform <id>` is validated against these keys; an
 * unknown id lists the valid ones and exits 1. Add a strategy here to teach the
 * wizard a new platform — the engine and helpers are untouched.
 */
const REGISTRY: Partial<Record<PlatformId, PlatformStrategy>> = {
  'ubuntu-vps': ubuntuVps,
  'macosx-ngrok': macosxNgrok,
  'macosx-cloudflare-tunnel': macosxCloudflareTunnel,
  'macosx-tailscale': macosxTailscale,
  'macosx-caddy': macosxCaddy,
  'macosx-external-proxy': macosxExternalProxy,
};

export function getStrategy(id: string): PlatformStrategy | undefined {
  return REGISTRY[id as PlatformId];
}

/** Ids that actually have a registered strategy (a subset of PLATFORM_IDS while phased). */
export function availablePlatformIds(): PlatformId[] {
  return PLATFORM_IDS.filter((id) => REGISTRY[id] !== undefined);
}
