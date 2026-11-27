import { z } from 'zod';
import type { ProviderCommandResult, ProviderConnectionState, ProviderId } from './provider-auth.ts';

type MethodStatus = Exclude<ProviderConnectionState, 'not-installed'>;
/** Missing method IDs mean the probe did not identify the login. */
export type ProviderMethodStatuses = Readonly<Partial<Record<string, MethodStatus>>>;

const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/g;

const claudeSubscription = z.object({
  loggedIn: z.literal(true),
  authMethod: z.literal('claude.ai'),
  apiProvider: z.literal('firstParty').optional(),
});

export function isClaudeSubscription(statusJson: unknown): boolean {
  return claudeSubscription.safeParse(statusJson).success;
}

const openCodeIntegrations = z.array(z.object({
  id: z.string(),
  connections: z.array(z.object({
    type: z.string(),
    method: z.string().optional(),
    status: z.object({ status: z.string() }).optional(),
  })).nonempty(),
}));

function openCodeJsonSubscription(output: string): MethodStatus {
  try {
    const parsed = openCodeIntegrations.safeParse(JSON.parse(output));
    if (!parsed.success) return 'unknown';
    const entries = parsed.data.filter(entry => entry.id === 'openai');
    if (!entries.length) return 'disconnected';
    if (entries.length !== 1) return 'unknown';
    const connections = entries[0]!.connections;
    if (!connections.every(c => c.type === 'credential' && c.method === 'oauth')) return 'unknown';
    if (connections.every(c => !c.status)) return 'connected';
    if (connections.every(c => c.status?.status === 'needs_auth')) return 'disconnected';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function openCodeSubscriptionStatus(result: ProviderCommandResult): MethodStatus {
  if (result.exitCode !== 0 || result.errorCode || result.signal || result.timedOut) return 'unknown';
  const output = result.stdout.replace(ansi, '').trim();
  if (output.startsWith('[')) return openCodeJsonSubscription(output);
  if (output === 'No authenticated integrations') return 'disconnected';
  // OpenCode 1.x prints the credential type. 2.x text only says "stored" for OAuth and keys.
  const lines = output.split(/\r?\n/).map(line => line.trim());
  const headers = lines.filter(line => /^┌\s+Credentials\b/i.test(line));
  const summaries = lines.filter(line => /^└\s+\d+ credentials?$/i.test(line));
  if (headers.length !== 1 || summaries.length !== 1) return 'unknown';
  const start = lines.indexOf(headers[0]!);
  const end = lines.indexOf(summaries[0]!);
  if (end <= start) return 'unknown';
  const rows = lines.slice(start + 1, end).filter(line => line && line !== '│');
  const count = Number(summaries[0]!.match(/\d+/)![0]);
  if (count !== rows.length || !rows.every(line => /^●\s+/.test(line))) return 'unknown';
  if (count === 0) return 'disconnected';
  const openai = rows.filter(line => /^●\s+OpenAI\s+/i.test(line));
  if (openai.length !== 1 || lines.slice(end + 1).some(line => /^●\s+OpenAI\s+/i.test(line))) return 'unknown';
  if (/^●\s+OpenAI\s+oauth$/i.test(openai[0]!)) return 'connected';
  return /^●\s+OpenAI\s+api$/i.test(openai[0]!) ? 'disconnected' : 'unknown';
}

/** Project only facts identified by this successful parse, without retaining the command output. */
export function observedProviderMethods(
  runner: ProviderId,
  status: ProviderConnectionState,
  result: ProviderCommandResult,
  env: NodeJS.ProcessEnv,
): ProviderMethodStatuses {
  if (result.signal || (status !== 'connected' && status !== 'disconnected')) return {};
  switch (runner) {
    case 'claude': {
      if (status === 'disconnected') return { subscription: 'disconnected' };
      // The aggregate parser has already verified this JSON and its exit code.
      return isClaudeSubscription(JSON.parse(result.stdout)) ? { subscription: 'connected' } : {};
    }
    case 'codex':
      if (status === 'disconnected') return { subscription: 'disconnected' };
      // The aggregate parser requires exactly one recognized answer across both channels.
      return /^\s*logged in using chatgpt\s*$/im.test((result.stdout + '\n' + result.stderr).replace(ansi, ''))
        ? { subscription: 'connected' } : {};
    case 'cursor': {
      // A key short-circuits the probe. Only an actual browser-login status command reaches here.
      if (status === 'connected' && result.exitCode !== 0) return {};
      if (result.stdout.trimStart().startsWith('{')) {
        try {
          const cursor = JSON.parse(result.stdout);
          if ((cursor.status === 'authenticated' && cursor.isAuthenticated === false)
            || (cursor.status === 'unauthenticated' && cursor.isAuthenticated === true)) return {};
        } catch {
          return {};
        }
      }
      return { subscription: status };
    }
    case 'gemini':
      // --version cannot distinguish an OS-stored key, a Vertex project, or a gateway.
      return env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() ? { apiKey: 'connected' } : {};
    case 'opencode':
    case 'pi':
    case 'omp': {
      // A model table / agent.db cannot identify OAuth. These three consume OpenRouter keys natively.
      const methods: Partial<Record<string, MethodStatus>> = {};
      if (env.OPENROUTER_API_KEY?.trim()) methods.openrouter = 'connected';
      if (runner === 'opencode') methods.openai = openCodeSubscriptionStatus(result);
      return methods;
    }
    case 'kimi':
    case 'copilot':
    case 'antigravity':
      // A provider type, ACP session or model list does not prove how the session is billed.
      return status === 'disconnected' ? { subscription: 'disconnected' } : {};
    case 'junie':
      return {};
  }
}
