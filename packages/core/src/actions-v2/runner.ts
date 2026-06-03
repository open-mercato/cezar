import Anthropic from '@anthropic-ai/sdk';
import type { ActionDef, ActionRunResult } from './action.js';
import type { Skill } from '../skills/skill-catalog.js';
import {
  formatLabelCatalogPrompt,
  type WorkspaceLabel,
} from '../labels/label-catalog.js';
import { actionAlreadyCommented, buildAutoCommentBody } from './auto-comment.js';
import {
  ALL_EFFECT_NAMES,
  EFFECT_REGISTRY,
  effectNameFromWire,
  effectsAsAnthropicTools,
  executeEffect,
  extractConfidence,
  type EffectCall,
  type EffectContext,
  type EffectName,
} from './effects.js';

/**
 * The runner hands off effects flagged for human review by writing to this
 * sink instead of executing them. Wired by the GUI dispatch layer to insert
 * into `pending_decisions`; the CLI passes no sink (deferred effects are
 * silently dropped, preserving CLI semantics).
 */
export interface DeferredEffect {
  call: EffectCall;
  confidence: number;
  /** Short human-readable summary for the inbox row. */
  summary: string;
}
export type DeferSink = (item: DeferredEffect) => Promise<void>;

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const MAX_TOOL_ITERATIONS = 8;

/**
 * The single payload describing the entity (issue or PR) an action targets.
 * The runner does not fetch this — callers (cron / webhook handlers / GUI)
 * pass it in. Keeping the runner pure simplifies testing.
 */
export interface ActionTarget {
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  htmlUrl: string;
  /** Optional pre-formatted comment context the runner can include. */
  comments?: string;
}

export interface RunActionDeps {
  /** Resolved skill catalog the runner uses to look up `skill_refs`. */
  skills: Skill[];
  /** Anthropic client. Caller can pass a custom instance for testing. */
  anthropic?: Anthropic;
  /** Effect context — passed through to effect executors when they fire. */
  effectCtx: EffectContext;
  /** Override the model for this run. Defaults to claude-sonnet-4-6. */
  model?: string;
  /** Auto-comment behaviour. When `enabled`, the runner posts a
   *  Cezar-branded summary comment after a successful run — unless the
   *  action itself already posted one via the `comment` effect. */
  autoComment?: {
    enabled: boolean;
    triggeredBy?: string;
  };
  /** Sink for effects routed to human review by the action's acceptance
   *  config. Omit to let those effects be dropped silently (CLI default). */
  deferSink?: DeferSink;
  /**
   * Workspace label catalog. When present, a "Repository label catalog"
   * section is appended to the system message (filtered to the target kind:
   * issue actions get issue+both labels, PR actions get pr+both). The
   * declarative-mode effect vocabulary (`add_label`, `remove_label`, …)
   * already lets actions apply labels — the catalog teaches the model
   * *which* names to use and *when*.
   */
  labels?: WorkspaceLabel[];
}

/**
 * Run a single Action against a single target. Dispatches on the action's
 * `effects` field:
 *
 *  - `effects != null` → "declared" mode. We ask for a JSON response shaped
 *    `{ effects: EffectCall[] }`, parse it, and execute the listed effects
 *    in order. The response also includes a `summary` field that we keep as
 *    the run's text output.
 *  - `effects == null` → "tool-use" mode. We hand the model the effect
 *    vocabulary as Anthropic tools and let it decide which to call mid-run.
 *    We iterate the tool-use loop until the model produces a final text
 *    response (max 8 iterations to bound runaway runs).
 */
export async function runAction(
  action: ActionDef,
  target: ActionTarget,
  deps: RunActionDeps,
): Promise<ActionRunResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const client = deps.anthropic ?? new Anthropic({ apiKey });

  const skillSection = resolveSkillContext(action.skillRefs, deps.skills);
  const labelCatalog = formatLabelCatalogPrompt(deps.labels ?? null, target.kind, target.kind);
  const systemMessage = [
    action.systemPrompt.trim(),
    skillSection,
    labelCatalog,
  ]
    .filter((s) => s && s.length > 0)
    .join('\n\n---\n\n');

  const userMessage = formatTarget(target);
  const model = action.model ?? deps.model ?? DEFAULT_MODEL;

  const result = action.effects && action.effects.length > 0
    ? await runDeclaredMode(action, target, {
        client,
        effectCtx: deps.effectCtx,
        model,
        systemMessage,
        userMessage,
        deferSink: deps.deferSink,
      })
    : await runToolUseMode(action, target, {
        client,
        effectCtx: deps.effectCtx,
        model,
        systemMessage,
        userMessage,
        deferSink: deps.deferSink,
      });

  if (deps.autoComment?.enabled && !actionAlreadyCommented(result.effectsApplied)) {
    const body = buildAutoCommentBody({
      actionName: action.name,
      text: result.text,
      effectsApplied: result.effectsApplied,
      meta: {
        actionName: action.name,
        triggeredBy: deps.autoComment.triggeredBy,
        model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
    });
    try {
      await deps.effectCtx.github.addComment(deps.effectCtx.targetNumber, body);
      result.effectsApplied.push({
        call: { effect: 'comment', args: { body } },
        summary: `auto-commented on #${deps.effectCtx.targetNumber}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.effectsApplied.push({
        call: { effect: 'comment', args: { body } },
        summary: `auto-comment failed: ${message}`,
      });
    }
  }

  return result;
}

// ─── Declared mode (structured JSON response) ──────────────────────────────

interface RunMode {
  client: Anthropic;
  effectCtx: EffectContext;
  model: string;
  systemMessage: string;
  userMessage: string;
  deferSink?: DeferSink;
}

async function runDeclaredMode(
  action: ActionDef,
  _target: ActionTarget,
  mode: RunMode,
): Promise<ActionRunResult> {
  const effectNames = action.effects ?? [];
  const declaredEffectsHint = describeDeclaredEffects(effectNames);

  const resp = await mode.client.messages.create({
    model: mode.model,
    max_tokens: MAX_TOKENS,
    system: `${mode.systemMessage}\n\n${declaredEffectsHint}`,
    messages: [{ role: 'user', content: mode.userMessage }],
  });

  const text = extractText(resp);
  const parsed = parseDeclaredResponse(text);

  const effectsApplied: Array<{ call: EffectCall; summary: string }> = [];
  for (const call of parsed.effects) {
    // Reject calls that the action didn't declare — the user said "this
    // action will only ever do X, Y", and we enforce that even if the model
    // tries to expand.
    if (!effectNames.includes(call.effect)) continue;
    const outcome = await applyOrDefer(call, action, mode.effectCtx, mode.deferSink);
    effectsApplied.push({ call, summary: outcome.summary });
  }

  return {
    text: parsed.summary ?? text,
    effectsApplied,
    usage: {
      inputTokens: resp.usage?.input_tokens ?? 0,
      outputTokens: resp.usage?.output_tokens ?? 0,
    },
  };
}

function describeDeclaredEffects(effects: EffectName[]): string {
  const lines = effects.map((name) => {
    const def = EFFECT_REGISTRY[name];
    return `- ${name}: ${def.description}`;
  });
  return [
    '## Required response format',
    '',
    'Respond ONLY with valid JSON in this shape — no markdown, no commentary:',
    '',
    '```json',
    '{',
    '  "summary": "one short sentence explaining what you decided",',
    '  "effects": [',
    '    { "effect": "<one of the names below>", "args": { /* args matching that effect\'s schema */ } }',
    '  ]',
    '}',
    '```',
    '',
    'Allowed effects (omit `effects` entirely if the right answer is "do nothing"):',
    ...lines,
  ].join('\n');
}

interface DeclaredResponse {
  summary?: string;
  effects: EffectCall[];
}

function parseDeclaredResponse(text: string): DeclaredResponse {
  const trimmed = text.trim();
  // Tolerate a markdown fence the model may have added despite instructions.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { effects: [] };
  }
  if (!parsed || typeof parsed !== 'object') return { effects: [] };
  const obj = parsed as Record<string, unknown>;
  const effects = Array.isArray(obj.effects)
    ? (obj.effects as unknown[])
        .map((e): EffectCall | null => {
          if (!e || typeof e !== 'object') return null;
          const eo = e as Record<string, unknown>;
          if (typeof eo.effect !== 'string') return null;
          const confRaw = eo.confidence;
          const confN = typeof confRaw === 'number' ? confRaw : Number(confRaw);
          const confidence = Number.isFinite(confN)
            ? Math.max(0, Math.min(100, Math.round(confN)))
            : undefined;
          return {
            effect: eo.effect as EffectName,
            args: eo.args ?? {},
            confidence,
          };
        })
        .filter((e): e is EffectCall => e !== null)
    : [];
  return {
    summary: typeof obj.summary === 'string' ? obj.summary : undefined,
    effects,
  };
}

// ─── Tool-use mode (agent calls effects mid-run) ───────────────────────────

async function runToolUseMode(
  action: ActionDef,
  _target: ActionTarget,
  mode: RunMode,
): Promise<ActionRunResult> {
  const tools = effectsAsAnthropicTools(ALL_EFFECT_NAMES);
  const effectsApplied: Array<{ call: EffectCall; summary: string }> = [];
  let usage = { inputTokens: 0, outputTokens: 0 };

  // Build the running message thread. We mutate `messages` across iterations
  // by appending each assistant turn and the corresponding tool_result.
  type ContentBlock = Record<string, unknown>;
  type Message = { role: 'user' | 'assistant'; content: string | ContentBlock[] };
  const messages: Message[] = [{ role: 'user', content: mode.userMessage }];
  let finalText = '';
  // Tracks whether the loop ran out of iterations while the model was still
  // calling tools. If it does, the run never produced a final answer — surface
  // that as a failure rather than returning an empty-text "success".
  let exhausted = true;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const resp = await mode.client.messages.create({
      model: mode.model,
      max_tokens: MAX_TOKENS,
      system: mode.systemMessage,
      tools: tools as unknown as Anthropic.Tool[],
      messages: messages as unknown as Anthropic.MessageParam[],
    });

    usage = {
      inputTokens: usage.inputTokens + (resp.usage?.input_tokens ?? 0),
      outputTokens: usage.outputTokens + (resp.usage?.output_tokens ?? 0),
    };

    // Append the model's turn verbatim so the next iteration sees its own
    // tool_use blocks.
    messages.push({ role: 'assistant', content: resp.content as unknown as ContentBlock[] });

    const toolUses = (resp.content as unknown as ContentBlock[]).filter(
      (b) => (b as { type?: string }).type === 'tool_use',
    );

    // No tool calls → this is the final answer. Capture the text blocks.
    if (toolUses.length === 0) {
      finalText = extractText(resp);
      exhausted = false;
      break;
    }

    // Execute every tool call the model issued, in order, and feed the
    // results back in a single user turn.
    const resultBlocks: ContentBlock[] = [];
    for (const block of toolUses) {
      const tu = block as { id: string; name: string; input: unknown };
      // `tu.name` came back wire-safe (no dots, see effectsAsAnthropicTools);
      // map it back to the canonical effect name before dispatching.
      const effect = effectNameFromWire(tu.name);
      if (!effect) {
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `unknown tool "${tu.name}"`,
          is_error: true,
        });
        continue;
      }
      const { args, confidence } = extractConfidence(tu.input ?? {});
      const call: EffectCall = { effect, args, confidence };
      const outcome = await applyOrDefer(call, action, mode.effectCtx, mode.deferSink);
      effectsApplied.push({ call, summary: outcome.summary });
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: outcome.summary,
        is_error: outcome.outcome === 'error',
      });
    }
    messages.push({ role: 'user', content: resultBlocks });
  }

  if (exhausted) {
    throw new Error(
      `tool-use loop exceeded ${MAX_TOOL_ITERATIONS} iterations without a final answer`,
    );
  }

  return {
    text: finalText,
    effectsApplied,
    usage,
  };
}

// ─── Acceptance routing ────────────────────────────────────────────────────

/**
 * Per-effect routing chokepoint. Reads the action's acceptance_mode +
 * confidence_config and either applies the effect, defers it to the human
 * inbox via `deferSink`, or drops it silently.
 *
 *   auto mode             → ≥ autoAcceptAbove : apply,  < : drop
 *   human-in-the-loop     → ≥ autoAcceptAbove : apply,
 *                           ≥ autoDenyBelow   : defer,
 *                           <                 : drop
 *
 * When no confidence is provided on the call, treats it as 100 (fully
 * confident) so existing actions that don't emit confidence keep applying
 * everything.
 */
async function applyOrDefer(
  call: EffectCall,
  action: ActionDef,
  ctx: EffectContext,
  deferSink: DeferSink | undefined,
): Promise<{ outcome: 'applied' | 'deferred' | 'dropped' | 'error'; summary: string }> {
  const confidence = call.confidence ?? 100;
  const mode = action.acceptanceMode ?? 'auto';
  const cfg = action.confidenceConfig ?? { autoAcceptAbove: 0 };
  const acceptAbove = cfg.autoAcceptAbove;
  const denyBelow = 'autoDenyBelow' in cfg ? cfg.autoDenyBelow : 0;

  if (confidence >= acceptAbove) {
    try {
      const summary = await executeEffect(call, ctx);
      return { outcome: 'applied', summary };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { outcome: 'error', summary: `error: ${message}` };
    }
  }

  if (mode === 'human-in-the-loop' && confidence >= denyBelow && deferSink) {
    try {
      const summary = `deferred to inbox (${call.effect} @ ${confidence}%)`;
      await deferSink({ call, confidence, summary });
      return { outcome: 'deferred', summary };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { outcome: 'error', summary: `defer failed: ${message}` };
    }
  }

  return {
    outcome: 'dropped',
    summary: `dropped (${call.effect} @ ${confidence}% < threshold)`,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractText(resp: Anthropic.Message): string {
  const out: string[] = [];
  for (const block of resp.content) {
    if (block.type === 'text') out.push(block.text);
  }
  return out.join('').trim();
}

function resolveSkillContext(refs: string[], skills: Skill[]): string {
  if (refs.length === 0) return '';
  const byName = new Map(skills.map((s) => [s.name, s]));
  const sections: string[] = [];
  for (const ref of refs) {
    const skill = byName.get(ref);
    if (!skill) continue;
    sections.push(`## Skill: ${skill.name}\n\n${skill.body.trim()}`);
  }
  if (sections.length === 0) return '';
  return ['# Reference skills', '', ...sections].join('\n\n');
}

function formatTarget(target: ActionTarget): string {
  const labels = target.labels.length > 0 ? target.labels.join(', ') : '(none)';
  const head = [
    `${target.kind === 'pr' ? 'PR' : 'Issue'} #${target.number} — ${target.title}`,
    `State: ${target.state}`,
    `Labels: ${labels}`,
    target.htmlUrl ? `URL: ${target.htmlUrl}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const body = ['', '## Body', target.body || '(empty)'].join('\n');
  const comments = target.comments ? `\n\n## Comments\n${target.comments}` : '';
  return `${head}${body}${comments}`;
}
