import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The auth methods a user can have configured that still work for Gemini CLI. Google sign-in
 * (`oauth-personal`) is deliberately absent: for individuals it now fails every session with
 * `UNSUPPORTED_CLIENT` (`__fixtures__/gemini/unsupported-client.ndjson`), so a host configured only
 * for it is not evidence of working credentials. Ids from `AuthType` in the 0.60.0 bundle.
 */
const WORKING_AUTH_TYPES: ReadonlySet<string> = new Set([
  'gemini-api-key',
  'vertex-ai',
  'gateway',
  'compute-default-credentials',
  'cloud-shell',
]);

/**
 * Does this host visibly hold credentials Gemini CLI can use? Gemini CLI has no `auth status`
 * subcommand, so cezar reads the same places the CLI reads (spec 2026-09-19 § Phase 2 "Detection and
 * auth"), all verified in the 0.60.0 bundle:
 *
 * - `GEMINI_API_KEY` / `GOOGLE_API_KEY`, or a custom gateway (`GOOGLE_GEMINI_BASE_URL`);
 * - Vertex AI: `GOOGLE_GENAI_USE_VERTEXAI=true` with a project (`GOOGLE_CLOUD_PROJECT`);
 * - the `.env` the CLI loads on its own: `<gemini home>/.gemini/.env`, then `<gemini home>/.env`,
 *   where the gemini home is `GEMINI_CLI_HOME`, else the OS home (`homedir()` in the bundle);
 * - the auth method the user chose in the CLI (`security.auth.selectedType` in
 *   `<gemini home>/.gemini/settings.json`), when it is one that still works. This goes beyond the
 *   spec's environment-only rule on purpose: the CLI's own `/auth` dialog stores an API key in the OS
 *   keychain (`HybridTokenStorage`, service `gemini-cli-api-key`), which cezar cannot read — and the
 *   provider gate refuses every run for a provider that is not `connected`. A key that turns out to
 *   be bad still surfaces at run time as `provider-auth-required`.
 *
 * `false` is NOT "logged out" — callers report `unknown` with the API-key hint, never
 * `disconnected`. Key VALUES are never read out: only whether a key line exists.
 */
export function geminiHasCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  if (present(env.GEMINI_API_KEY) || present(env.GOOGLE_API_KEY) || present(env.GOOGLE_GEMINI_BASE_URL)) return true;
  if (env.GOOGLE_GENAI_USE_VERTEXAI === 'true' && present(env.GOOGLE_CLOUD_PROJECT)) return true;
  const home = present(env.GEMINI_CLI_HOME) ? env.GEMINI_CLI_HOME! : homedir();
  if ([join(home, '.gemini', '.env'), join(home, '.env')].some(definesKey)) return true;
  const selected = selectedAuthType(join(home, '.gemini', 'settings.json'));
  return selected !== undefined && WORKING_AUTH_TYPES.has(selected);
}

function definesKey(path: string): boolean {
  const text = readText(path);
  return text !== undefined && /^\s*(?:export\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*\S/m.test(text);
}

function selectedAuthType(path: string): string | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    const settings = JSON.parse(text) as { security?: { auth?: { selectedType?: unknown } } };
    const selected = settings?.security?.auth?.selectedType;
    return typeof selected === 'string' ? selected : undefined;
  } catch {
    return undefined;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function present(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}
