import { discoverJunieModels } from './junie-model-catalog.ts';

const AUTH_CHECK_LIMIT = 300;

/** Verify authentication and model access through a bounded, prompt-free ACP session. */
export async function probeJunieAuthentication(options: {
  cwd: string;
  bin?: string;
  spawn?: Parameters<typeof discoverJunieModels>[0]['spawn'];
  timeoutMs?: number;
}): Promise<{ connected: boolean; hint?: string; notInstalled?: boolean }> {
  try {
    const models = await discoverJunieModels(options);
    if (models.length > 0) return { connected: true };
    return { connected: false, hint: 'Junie did not return any available models.' };
  } catch (error) {
    // The binary itself is missing (spawn ENOENT) — distinct from "installed but the ACP
    // handshake failed", which is a genuinely unknown auth state (#M1 review).
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return { connected: false, notInstalled: true, hint: safeDiagnostic(errorMessage(error)) };
    }
    return { connected: false, hint: `Junie model verification failed: ${safeDiagnostic(errorMessage(error))}` };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeDiagnostic(value: string): string {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(?:bearer\s+)[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:api[-_ ]?key|token|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, AUTH_CHECK_LIMIT) || 'unknown ACP error';
}