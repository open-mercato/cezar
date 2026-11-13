import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { cezarHomeDir } from '../paths.ts';

/** Where the model gateway's sealed record lives (spec 2026-11-10-model-gateway). A leaf module:
 *  `core/provider-auth.ts` reads it, and the store's own imports reach back to provider-auth. */
export function modelGatewayPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'model-gateway', 'gateway.vault');
}

/** A gateway is stored — the synchronous read every `ProviderAuthService` makes by default. */
export function modelGatewayConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(modelGatewayPath(env));
}
