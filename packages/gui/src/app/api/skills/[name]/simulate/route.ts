import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { checkRateLimit, isPromptTooLarge, MAX_PROMPT_BYTES } from '@/lib/simulate-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SimulatePayload {
  issueNumber: number;
  body?: string;
}

interface IssueRow {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  html_url: string;
}

interface OverrideRow {
  body: string;
}

const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 1024;

/**
 * Streams a dry-run simulation of a skill against a workspace issue.
 *
 * Resolves the system prompt in this priority order:
 *   1. `body` from the request (the live edit buffer on the detail page)
 *   2. The override's body, if one exists
 * Then sends a single non-tool-use message to Anthropic with a JSON-shaped
 * user prompt describing the issue, and streams text deltas back to the
 * client as `text/plain`.
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
  const skillName = decodeURIComponent(rawName);

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
  const [{ data: issue }, { data: override }] = await Promise.all([
    supabase
      .from('issues')
      .select('number, title, body, state, labels, html_url')
      .eq('workspace_id', workspace.id)
      .eq('number', payload.issueNumber)
      .maybeSingle<IssueRow>(),
    supabase
      .from('skill_overrides')
      .select('body')
      .eq('workspace_id', workspace.id)
      .eq('skill_name', skillName)
      .maybeSingle<OverrideRow>(),
  ]);

  if (!issue) return new Response('Issue not found', { status: 404 });

  const systemPrompt = (payload.body ?? override?.body ?? '').trim();
  if (!systemPrompt) {
    return new Response('No skill prompt to simulate — provide a body or save an override first.', {
      status: 400,
    });
  }
  if (isPromptTooLarge(systemPrompt)) {
    return new Response(
      `Skill prompt is too large to simulate (max ${MAX_PROMPT_BYTES / 1024} KiB).`,
      { status: 413 },
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response('ANTHROPIC_API_KEY is not configured on the server.', { status: 503 });
  }

  // Dynamic import keeps the SDK out of the edge bundle and avoids
  // type-resolution churn — the package is hoisted to the workspace root
  // because @cezar/core already depends on it.
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
      controller.enqueue(encoder.encode(`[${ts()}] INFO: Resolving prompt for ${skillName}…\n`));
      controller.enqueue(
        encoder.encode(`[${ts()}] INFO: Calling ${DEFAULT_MODEL} on issue #${issue.number}\n\n`),
      );

      try {
        const sdkStream = client.messages.stream({
          model: DEFAULT_MODEL,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
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

        // Wait for the stream to finish.
        for await (const _ of sdkStream as AsyncIterable<unknown>) {
          // We consume the iterable to drain, the `on('text')` callback above
          // is what actually pushes output to the client.
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
