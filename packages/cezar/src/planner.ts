import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createRunner } from './core/runner-factory.ts';
import { loadConfig } from './config.ts';
import { discoverSkills, type Skill } from './skills.ts';
import { resolveProfileEnvForRoot } from './workspace/agent-profiles.ts';
import { workflowStepSchema, type WorkflowStepDef } from './workflows/types.ts';

/**
 * Chain-from-prompt (spec 008): one cheap `claude` call turns the user's task
 * into a proposed chain of workflow steps built from the skills at hand plus a
 * detected verification command. The planner NEVER blocks the user — any
 * error, timeout or unparseable answer degrades to a one-step quick-task plan
 * with `fallback: true` so the GUI can show a dim note.
 */

const PLANNER_TIMEOUT_MS = 60_000;

const PLANNER_SYSTEM_PROMPT =
  'You are a planning assistant for an AI coding agent cockpit. Respond with ONLY a JSON object: ' +
  '{"title":string,"steps":[{"skill"?:string,"name":string,"prompt"?:string,"command"?:string}],"rationale":string}. ' +
  'Rules: pick skills ONLY from the provided catalog; a step has either "prompt" (an agent step) or ' +
  '"command" (a shell verification check); include the {{task}} placeholder in agent prompts where ' +
  "the user's task text belongs; 1-5 steps; prefer fewer; \"title\" is a short kebab-case name for " +
  'the whole workflow (2-4 words, e.g. "fix-and-review").';

const plannerResponseSchema = z.object({
  /** A short workflow name the builder pre-fills. Optional so older / partial answers still parse. */
  title: z.string().optional(),
  steps: z
    .array(
      z.object({
        skill: z.string().optional(),
        name: z.string().min(1),
        prompt: z.string().optional(),
        command: z.string().optional(),
      }),
    )
    .min(1)
    .max(5),
  rationale: z.string().default(''),
});

export interface PlanResult {
  /** The proposed workflow title (kebab-case slug), when the planner named one. The auto chain
   *  creator pre-fills the builder's name field with it. Absent on the degraded fallback. */
  name?: string;
  steps: WorkflowStepDef[];
  rationale: string;
  /** True when this is the degraded one-step quick-task plan. */
  fallback: boolean;
}

export async function planChain(repoRoot: string, task: string): Promise<PlanResult> {
  const [skills, config, verifyCommands] = await Promise.all([
    discoverSkills(repoRoot),
    loadConfig(repoRoot),
    detectVerifyCommands(repoRoot),
  ]);
  const skillNames = new Set(skills.map((s) => s.name));
  const userPrompt = buildPlannerPrompt(task, skills, verifyCommands);

  // Plan with the configured default runner. `plannerModel` ("sonnet") is a
  // Claude alias, so only pass it when the planner runs on Claude — Codex /
  // OpenCode pick their own default model instead.
  const runner = createRunner(config.defaultRunner);
  const plannerModel = config.defaultRunner === 'claude' ? config.plannerModel : undefined;
  // Plan under the SAME agent account this project's tasks run on (spec
  // 2026-07-29-agent-profiles). Without this the planner would quietly bill the personal
  // subscription for a project the user pointed at their work account.
  const { env: profileEnv } = await resolveProfileEnvForRoot(repoRoot, config.defaultRunner);
  // One retry on an unparseable answer; a runner error goes straight to fallback.
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      const result = await runner.run({
        systemPrompt: PLANNER_SYSTEM_PROMPT,
        userPrompt,
        cwd: repoRoot,
        allowedTools: [],
        ...(Object.keys(profileEnv).length > 0 ? { env: profileEnv } : {}),
        model: plannerModel,
        timeoutMs: PLANNER_TIMEOUT_MS,
      });
      text = result.text;
    } catch {
      break;
    }
    const parsed = parseStructured(text, plannerResponseSchema);
    if (!parsed) continue;
    const steps = sanitizeSteps(parsed.steps, skillNames);
    if (steps.length === 0) break; // everything got rejected — degrade
    const name = proposeWorkflowName(parsed.title);
    return { ...(name ? { name } : {}), steps, rationale: parsed.rationale, fallback: false };
  }

  return {
    steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
    rationale: 'planner unavailable — single-step plan',
    fallback: true,
  };
}

/** The `[cez-planner]` marker lets the CEZ_DRY_RUN mock recognize a planning call. */
function buildPlannerPrompt(task: string, skills: Skill[], verifyCommands: string[]): string {
  const catalog = skills.length
    ? skills.map((s) => `- ${s.name} — ${s.description ?? ''}`).join('\n')
    : '(no skills available)';
  const verify = verifyCommands.length
    ? verifyCommands.map((c) => `- ${c}`).join('\n')
    : '(none detected)';
  return [
    '[cez-planner] Plan a chain of steps for this task.',
    '',
    'Task:',
    task,
    '',
    'Skill catalog (name — description):',
    catalog,
    '',
    'Verification commands detected in this repo:',
    verify,
  ].join('\n');
}

/**
 * Detect verification commands the planner may propose as `check` steps:
 * `package.json` scripts (test/lint/build) and Makefile targets (first 50
 * lines). Best effort — an unreadable file just contributes nothing.
 */
async function detectVerifyCommands(repoRoot: string): Promise<string[]> {
  const out: string[] = [];
  const pkgSchema = z.object({ scripts: z.record(z.string(), z.string()).default({}) });
  try {
    const raw: unknown = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    const pkg = pkgSchema.safeParse(raw);
    if (pkg.success) {
      if (pkg.data.scripts['test']) out.push('npm test');
      if (pkg.data.scripts['lint']) out.push('npm run lint');
      if (pkg.data.scripts['build']) out.push('npm run build');
    }
  } catch {
    // no package.json — fine
  }
  try {
    const make = await readFile(join(repoRoot, 'Makefile'), 'utf8');
    for (const line of make.split('\n').slice(0, 50)) {
      const m = /^([A-Za-z0-9_.-]+):(?!=)/.exec(line);
      if (m && m[1] && !m[1].startsWith('.')) out.push(`make ${m[1]}`);
      if (out.length >= 8) break;
    }
  } catch {
    // no Makefile — fine
  }
  return out;
}

/**
 * Turn the model's raw steps into valid `WorkflowStepDef`s: exactly one of
 * prompt/command, unknown skills stripped (the prompt still carries the step),
 * ids derived from names with `-2`-style dedup. Steps that can't be repaired
 * are dropped — the caller falls back when nothing survives.
 */
function sanitizeSteps(
  raw: Array<{ skill?: string; name: string; prompt?: string; command?: string }>,
  skillNames: Set<string>,
): WorkflowStepDef[] {
  const out: WorkflowStepDef[] = [];
  const usedIds = new Set<string>();
  for (const s of raw) {
    let skill = s.skill?.trim() || undefined;
    const prompt = s.prompt?.trim() || undefined;
    const command = s.command?.trim() || undefined;
    if (Boolean(prompt) === Boolean(command)) continue; // needs exactly one
    if (command) skill = undefined; // a shell check carries no skill
    if (skill && !skillNames.has(skill)) skill = undefined; // unknown skill → plain prompt
    const id = uniqueId(slugify(s.name) || 'step', usedIds);
    const candidate = workflowStepSchema.safeParse({
      id,
      name: s.name,
      ...(skill ? { skill } : {}),
      ...(prompt ? { prompt } : {}),
      ...(command ? { command } : {}),
    });
    if (!candidate.success) continue;
    usedIds.add(id);
    out.push(candidate.data);
  }
  return out;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The proposed workflow title, normalized to the same kebab-case slug the builder saves as a
 * file name — so what the auto chain creator pre-fills is already a valid workflow name. A blank
 * or slug-less title (e.g. all punctuation) answers undefined, and the caller keeps the current
 * name instead of blanking it.
 */
export function proposeWorkflowName(raw: string | undefined): string | undefined {
  const slug = slugify((raw ?? '').trim());
  return slug || undefined;
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!used.has(id)) return id;
  }
}

/**
 * Best-effort structured-output extraction (trimmed from @cezar/core's
 * `parseStructured`): try the whole string after stripping a ```json fence,
 * then scan for balanced top-level `{...}` blocks and return the first that
 * validates. Null when nothing does — the caller decides how to recover.
 */
export function parseStructured<T>(raw: string, schema: z.ZodType<T, unknown>): T | null {
  const cleaned = raw
    .replace(/^```(?:json|javascript|js|jsonl)?\s*\n?/im, '')
    .replace(/\n?```\s*$/m, '')
    .trim();
  try {
    return schema.parse(JSON.parse(cleaned));
  } catch {
    for (const candidate of extractJsonObjectCandidates(raw)) {
      try {
        return schema.parse(JSON.parse(candidate));
      } catch {
        continue;
      }
    }
    return null;
  }
}

function extractJsonObjectCandidates(raw: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return candidates;
}
