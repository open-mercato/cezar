import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { checkRateLimit, isPromptTooLarge, MAX_PROMPT_BYTES } from '@/lib/simulate-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SimulatePayload {
  issueNumber: number;
  systemPrompt?: string;
  skillRefs?: string[];
  effects?: string[] | null;
}

interface IssueRow {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  html_url: string;
}

interface DbActionRow {
  id: string;
  name: string;
  kind: 'built-in' | 'user';
  system_prompt: string;
  skill_refs: unknown;
  target: 'issue' | 'pr';
  effects: unknown;
}

const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 1024;

/**
 * Dry-run simulator for an Action. Resolves the system prompt + skill refs
 * (live values from the editor take precedence, falling back to the stored
 * action row), assembles the same context the runtime would, and streams
 * Anthropic's text response back. No effects fire — this is observation-only.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const user = await getSessionUser();
  if (!user) return new Response('Not authenticated', { status: 401 });

  const workspace = await getActiveWorkspace();
  if (!workspace) return new Response('No workspace selected', { status: 400 });

  const rate = checkRateLimit(user.id);
  if (!rate.ok) {
    return new Response('Too many simulations — slow down and try again shortly.', {
      status: 429,
      headers: { 'retry-after': String(rate.retryAfterSec) },
    });
  }

  const { name: rawName } = await ctx.params;
  const actionName = decodeURIComponent(rawName);

  let payload: SimulatePayload;
  try {
    payload = (await req.json()) as SimulatePayload;
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }
  if (typeof payload.issueNumber !== 'number' || !Number.isFinite(payload.issueNumber)) {
    return new Response('Missing issueNumber', { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const [{ data: issue }, { data: rows }, { data: skillsRow }] = await Promise.all([
    supabase
      .from('issues')
      .select('number, title, body, state, labels, html_url')
      .eq('workspace_id', workspace.id)
      .eq('number', payload.issueNumber)
      .maybeSingle<IssueRow>(),
    supabase
      .from('actions')
      .select('id, name, kind, system_prompt, skill_refs, target, effects')
      .eq('workspace_id', workspace.id)
      .eq('name', actionName)
      .returns<DbActionRow[]>(),
    supabase
      .from('repo_skills')
      .select('skills')
      .eq('workspace_id', workspace.id)
      .eq('repo', workspace.repoName)
      .maybeSingle<{ skills: unknown }>(),
  ]);

  if (!issue) return new Response('Issue not found', { status: 404 });
  if (!rows || rows.length === 0) return new Response('Action not found', { status: 404 });

  const preferred = rows.find((r) => r.kind === 'user') ?? rows[0];
  const systemPrompt =
    (payload.systemPrompt ?? preferred.system_prompt ?? '').trim();
  if (!systemPrompt) {
    return new Response('Action has no system prompt to simulate.', { status: 400 });
  }
  if (isPromptTooLarge(systemPrompt)) {
    return new Response(
      `System prompt is too large to simulate (max ${MAX_PROMPT_BYTES / 1024} KiB).`,
      { status: 413 },
    );
  }

  const skillRefs = Array.isArray(payload.skillRefs)
    ? payload.skillRefs
    : Array.isArray(preferred.skill_refs)
      ? (preferred.skill_refs as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];

  const skillCatalog = Array.isArray(skillsRow?.skills)
    ? (skillsRow!.skills as Array<{ name?: unknown; description?: unknown }>)
    : [];
  const refDescriptions = skillRefs
    .map((ref) => {
      const match = skillCatalog.find((s) => s.name === ref);
      const desc = match && typeof match.description === 'string' ? match.description : null;
      return desc ? `- ${ref}: ${desc}` : `- ${ref}`;
    })
    .join('\n');
  const skillSection = refDescriptions
    ? `\n\n# Reference skills (descriptions only — full bodies are loaded at runtime)\n\n${refDescriptions}`
    : '';

  const effectsLine = Array.isArray(payload.effects)
    ? `Declared effects: ${payload.effects.join(', ') || '(none)'}`
    : 'Effect mode: agent tools';

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response('ANTHROPIC_API_KEY is not configured on the server.', { status: 503 });
  }

  const { default: Anthropic } = (await import('@anthropic-ai/sdk')) as {
    default: new (opts: { apiKey: string }) => {
      messages: {
        stream: (input: unknown) => AsyncIterable<unknown> & {
          on: (event: string, cb: (data: unknown) => void) => void;
          controller?: { abort: () => void };
        };
      };
    };
  };

  const client = new Anthropic({ apiKey });

  const userPrompt = [
    `# Test issue #${issue.number} — ${issue.title}`,
    `State: ${issue.state}`,
    issue.labels?.length ? `Labels: ${issue.labels.join(', ')}` : null,
    issue.html_url ? `URL: ${issue.html_url}` : null,
    '',
    '## Body',
    issue.body || '(empty body)',
  ]
    .filter(Boolean)
    .join('\n');

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const ts = () => new Date().toISOString().slice(11, 19);
      controller.enqueue(encoder.encode(`[${ts()}] INFO: Simulating ${actionName} on #${issue.number}\n`));
      controller.enqueue(encoder.encode(`[${ts()}] INFO: ${effectsLine}\n\n`));

      try {
        const sdkStream = client.messages.stream({
          model: DEFAULT_MODEL,
          max_tokens: MAX_TOKENS,
          system: `${systemPrompt}${skillSection}`,
          messages: [{ role: 'user', content: userPrompt }],
        });

        // If the client disconnects, cancel the upstream Anthropic call so we
        // stop paying for tokens no one will read.
        req.signal.addEventListener('abort', () => {
          try {
            sdkStream.controller?.abort();
          } catch {
            /* best-effort */
          }
        });

        sdkStream.on('text', (delta: unknown) => {
          if (typeof delta === 'string') {
            controller.enqueue(encoder.encode(delta));
          }
        });
        sdkStream.on('error', (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          controller.enqueue(encoder.encode(`\n\n[${ts()}] ERROR: ${msg}\n`));
        });

        for await (const _ of sdkStream as AsyncIterable<unknown>) {
          void _;
        }
        controller.enqueue(encoder.encode(`\n\n[${ts()}] SUCCESS: Simulation complete.\n`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`\n[${ts()}] ERROR: ${msg}\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
