import { z } from 'zod';
import type { GitHubService } from '../services/github.service.js';

/**
 * The effect vocabulary an Action can declare (then enforced post-response
 * against a JSON output schema) or expose to the agent as Anthropic tools
 * (then called mid-run as the model decides). Both modes use this same
 * registry so the surface is identical.
 *
 * Adding a new effect: append a new entry to `EFFECT_REGISTRY` with a Zod
 * schema for its input and an `execute(args, ctx)` async fn. Both schemas
 * and the executor list flow through one source of truth.
 */

export interface EffectContext {
  github: GitHubService;
  /** Issue or PR number the action is targeting. */
  targetNumber: number;
  /** Workspace-scoped Supabase client for effects that need to write rows
   *  (e.g. link-duplicate writing to a relations table). Optional — many
   *  effects don't need DB access. Wired by the runner. */
  supabase?: unknown;
}

export interface EffectDef<TArgs = unknown> {
  /** Machine name — also the tool name when exposed to the agent. */
  name: string;
  description: string;
  schema: z.ZodType<TArgs>;
  /** Side-effect executor. Returns a short summary string for the run log. */
  execute(args: TArgs, ctx: EffectContext): Promise<string>;
}

// ─── Effect definitions ────────────────────────────────────────────────────

const labelAdd: EffectDef<{ label: string }> = {
  name: 'label.add',
  description: "Add a single label to the target issue or PR.",
  schema: z.object({ label: z.string().min(1) }),
  async execute({ label }, { github, targetNumber }) {
    await github.addLabel(targetNumber, label);
    return `added label "${label}" to #${targetNumber}`;
  },
};

const labelRemove: EffectDef<{ label: string }> = {
  name: 'label.remove',
  description: "Remove a label from the target issue or PR.",
  schema: z.object({ label: z.string().min(1) }),
  async execute({ label }, { github, targetNumber }) {
    await github.removeLabel(targetNumber, label);
    return `removed label "${label}" from #${targetNumber}`;
  },
};

const labelSet: EffectDef<{ labels: string[] }> = {
  name: 'label.set',
  description:
    "Replace the full label set on the target with these labels (others are removed). Use sparingly — prefer label.add / label.remove.",
  schema: z.object({ labels: z.array(z.string().min(1)) }),
  async execute({ labels }, { github, targetNumber }) {
    await github.setLabels(targetNumber, labels);
    return `set labels [${labels.join(', ')}] on #${targetNumber}`;
  },
};

const comment: EffectDef<{ body: string }> = {
  name: 'comment',
  description:
    "Post a comment on the target. Use sparingly — keep tone professional, do not spam. Returns the new comment id.",
  schema: z.object({ body: z.string().min(1) }),
  async execute({ body }, { github, targetNumber }) {
    const commentId = await github.addComment(targetNumber, body);
    return `posted comment ${commentId} on #${targetNumber}`;
  },
};

const close: EffectDef<{ reason?: 'completed' | 'not_planned' }> = {
  name: 'close',
  description:
    "Close the target issue. reason='completed' for done, 'not_planned' for won't-fix / duplicate. Defaults to 'completed'.",
  schema: z.object({
    reason: z.enum(['completed', 'not_planned']).optional(),
  }),
  async execute({ reason }, { github, targetNumber }) {
    await github.closeIssue(targetNumber, reason ?? 'completed');
    return `closed #${targetNumber} (${reason ?? 'completed'})`;
  },
};

const assign: EffectDef<{ assignees: string[] }> = {
  name: 'assign',
  description: "Add one or more GitHub usernames as assignees on the target.",
  schema: z.object({ assignees: z.array(z.string().min(1)).min(1) }),
  async execute({ assignees }, { github, targetNumber }) {
    await github.addAssignees(targetNumber, assignees);
    return `assigned [${assignees.join(', ')}] to #${targetNumber}`;
  },
};

const linkDuplicate: EffectDef<{ duplicateOf: number; reason?: string }> = {
  name: 'link-duplicate',
  description:
    "Mark the target as a duplicate of another issue. Posts a comment linking the canonical issue and adds a 'duplicate' label. Does NOT close the issue — pair with `close` if you want that behaviour.",
  schema: z.object({
    duplicateOf: z.number().int().positive(),
    reason: z.string().optional(),
  }),
  async execute({ duplicateOf, reason }, { github, targetNumber }) {
    // Idempotency: re-running on an edited issue (or a webhook re-delivery)
    // must not re-post the "Duplicate of #N" comment / re-add the label.
    // Best-effort — if the comment fetch fails we fall through and post,
    // preserving the prior behaviour.
    const marker = `Duplicate of #${duplicateOf}`;
    try {
      const existing = await github.listIssueCommentsWithIds(targetNumber);
      if (existing.some((c) => c.body.includes(marker))) {
        return `#${targetNumber} already linked as duplicate of #${duplicateOf}`;
      }
    } catch {
      // ignore — proceed to post.
    }
    const note = reason ? ` Reason: ${reason}` : '';
    await github.addComment(
      targetNumber,
      `${marker}.${note}`,
    );
    await github.addLabel(targetNumber, 'duplicate');
    return `linked #${targetNumber} as duplicate of #${duplicateOf}`;
  },
};

const setPriority: EffectDef<{ priority: 'critical' | 'high' | 'medium' | 'low' }> = {
  name: 'set-priority',
  description:
    "Set a priority/<level> label on the target. Replaces any existing priority/* label.",
  schema: z.object({ priority: z.enum(['critical', 'high', 'medium', 'low']) }),
  async execute({ priority }, { github, targetNumber }) {
    // Best-effort: GitHub's API requires us to fetch+filter before re-setting
    // labels to remove an existing priority/* label. We rely on the runner
    // (or the agent) calling label.remove first if it matters; here we just
    // add the new priority label.
    await github.addLabel(targetNumber, `priority/${priority}`);
    return `set priority/${priority} on #${targetNumber}`;
  },
};

// ─── Registry + helpers ────────────────────────────────────────────────────

export const EFFECT_REGISTRY = {
  'label.add': labelAdd,
  'label.remove': labelRemove,
  'label.set': labelSet,
  comment,
  close,
  assign,
  'link-duplicate': linkDuplicate,
  'set-priority': setPriority,
} as const satisfies Record<string, EffectDef<unknown>>;

export type EffectName = keyof typeof EFFECT_REGISTRY;
export const ALL_EFFECT_NAMES = Object.keys(EFFECT_REGISTRY) as EffectName[];

/**
 * An effect invocation — the runtime shape produced either by the model
 * (declared mode: as part of the structured response) or by the runner
 * (undeclared mode: synthesised from tool_use blocks).
 */
export interface EffectCall<N extends EffectName = EffectName> {
  effect: N;
  args: unknown;
  /** Model-self-reported confidence in 0..100. Optional; absent ≡ 100 (fully
   *  confident). Used by the runner to route effects when the producing
   *  action's `acceptanceMode='human-in-the-loop'`. */
  confidence?: number;
}

/**
 * Execute a single effect call after validating its args against the
 * registered schema. Returns the executor's summary, or throws on validation
 * / executor failure (the runner decides how to surface this in the agent
 * run log).
 */
export async function executeEffect(
  call: EffectCall,
  ctx: EffectContext,
): Promise<string> {
  const def = EFFECT_REGISTRY[call.effect] as EffectDef<unknown> | undefined;
  if (!def) throw new Error(`unknown effect: ${call.effect}`);
  const parsed = def.schema.safeParse(call.args);
  if (!parsed.success) {
    throw new Error(`invalid args for ${call.effect}: ${parsed.error.message}`);
  }
  return def.execute(parsed.data, ctx);
}

/**
 * Anthropic's tool-name regex is `^[a-zA-Z0-9_-]{1,128}$` — no dots. Our
 * effect names (`label.add`, `label.remove`, `label.set`) use dots as the
 * namespace separator, so we translate `.` → `_` on the wire. `wireToolName`
 * is what goes into the tools array sent to the API; `effectNameFromWire`
 * maps the name on a `tool_use` block back to the registry key.
 */
export function wireToolName(name: EffectName): string {
  return name.replace(/\./g, '_');
}

export function effectNameFromWire(wire: string): EffectName | null {
  // Fast path: name was wire-safe to begin with (`comment`, `close`, `assign`,
  // `link-duplicate`, `set-priority`).
  if ((ALL_EFFECT_NAMES as readonly string[]).includes(wire)) return wire as EffectName;
  // Restore dots — only effect names with `_` correspond to namespaced keys.
  const dotted = wire.replace(/_/g, '.');
  if ((ALL_EFFECT_NAMES as readonly string[]).includes(dotted)) return dotted as EffectName;
  return null;
}

/**
 * Convert the effect registry into the JSON-Schema shape Anthropic's tool-use
 * API expects. Used by the undeclared-mode runner.
 */
export function effectsAsAnthropicTools(allowed: readonly EffectName[] = ALL_EFFECT_NAMES) {
  return allowed.map((name) => {
    const def = EFFECT_REGISTRY[name];
    // Inject an optional `_confidence` parameter into every tool's schema so
    // the model can self-report confidence on each effect call. The runner
    // strips it from args before validating against the Zod schema. Keeping
    // confidence out of the Zod schemas avoids polluting every effect's
    // typed signature with HITL plumbing.
    const base = zodToInputSchema(def.schema as z.ZodType<unknown>) as {
      properties?: Record<string, unknown>;
      [k: string]: unknown;
    };
    return {
      name: wireToolName(name),
      description:
        def.description +
        ' Include `_confidence` (0-100 integer) reflecting how certain you are this effect should fire; omit if unsure.',
      input_schema: {
        ...base,
        properties: {
          ...(base.properties ?? {}),
          _confidence: {
            type: 'integer',
            minimum: 0,
            maximum: 100,
            description:
              'Self-reported confidence (0-100) that this effect should fire. Used by Cezar for human-in-the-loop routing.',
          },
        },
      },
    };
  });
}

/**
 * Pull the optional `_confidence` field out of a tool-use args object,
 * returning the remaining args and the extracted confidence (if present
 * and well-formed). Args are returned unchanged when no `_confidence`
 * is present.
 */
export function extractConfidence(rawArgs: unknown): {
  args: unknown;
  confidence?: number;
} {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return { args: rawArgs };
  }
  const obj = rawArgs as Record<string, unknown>;
  if (!('_confidence' in obj)) return { args: rawArgs };
  const raw = obj._confidence;
  const { _confidence: _, ...rest } = obj;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return { args: rest };
  return { args: rest, confidence: Math.max(0, Math.min(100, Math.round(n))) };
}

/**
 * Minimal Zod → JSON-Schema-ish converter for the small subset of shapes our
 * effect schemas use (object with string / number / enum / boolean / array
 * fields, all required unless `.optional()`). Avoids the `zod-to-json-schema`
 * dep for now since the surface is tiny and stable.
 */
export function zodToInputSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const def = (schema as unknown as { _def: { typeName: string } })._def;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as unknown as { shape: Record<string, z.ZodType<unknown>> }).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        const inner = unwrapOptional(v);
        properties[k] = zodToInputSchema(inner.schema);
        if (!inner.optional) required.push(k);
      }
      return { type: 'object', properties, required };
    }
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodArray': {
      const element = (schema as unknown as { element: z.ZodType<unknown> }).element;
      return { type: 'array', items: zodToInputSchema(element) };
    }
    case 'ZodEnum': {
      const values = (schema as unknown as { _def: { values: string[] } })._def.values;
      return { type: 'string', enum: values };
    }
    case 'ZodOptional':
      return zodToInputSchema((schema as unknown as { _def: { innerType: z.ZodType<unknown> } })._def.innerType);
    default:
      return {};
  }
}

function unwrapOptional(schema: z.ZodType<unknown>): { schema: z.ZodType<unknown>; optional: boolean } {
  const def = (schema as unknown as { _def: { typeName: string; innerType?: z.ZodType<unknown> } })._def;
  if (def.typeName === 'ZodOptional' && def.innerType) {
    return { schema: def.innerType, optional: true };
  }
  return { schema, optional: false };
}
