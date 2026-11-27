import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { stripJsonComments } from '../agent-config/validate.ts';

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
 * - Code Assist: `GOOGLE_GENAI_USE_GCA=true` (Workspace / Standard licences, Google sign-in);
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
  // Code Assist (Workspace / Standard licences): the CLI's own selector; a bad sign-in still
  // surfaces at run time as `provider-auth-required`.
  if (env.GOOGLE_GENAI_USE_GCA === 'true') return true;
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

/** ACP loads settings before it considers the key. Never overwrite a native or admin login choice. */
export function geminiAllowsProviderKey(cwd: string, env: NodeJS.ProcessEnv): boolean {
  const system = env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || (process.platform === 'darwin'
    ? '/Library/Application Support/GeminiCli/settings.json'
    : process.platform === 'win32' ? 'C:\\ProgramData\\gemini-cli\\settings.json' : '/etc/gemini-cli/settings.json');
  const paths = new Set([
    env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH || join(dirname(system), 'system-defaults.json'),
    join(env.GEMINI_CLI_HOME || env.HOME || homedir(), '.gemini', 'settings.json'),
    join(cwd, '.gemini', 'settings.json'),
    system,
  ]);
  for (const path of paths) {
    try {
      const { security } = JSON.parse(stripJsonComments(readFileSync(path, 'utf8')));
      const auth = security?.auth;
      if (auth && (auth.useExternal || [auth.selectedType, auth.enforcedType].some(type => type && type !== 'gemini-api-key'))) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  return true;
}
