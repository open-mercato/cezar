import { z } from 'zod';
import { loadConfig } from '../config.ts';
import { readGlobalInstructions } from '../core/global-instructions.ts';
import { createRunner } from '../core/runner-factory.ts';
import { parseStructured } from '../planner.ts';
import { NAMER_TIMEOUT_MS } from '../runs/auto-name.ts';
import { resolveNamerModel } from '../runs/namer-model.ts';
import { INTERNAL_CONSUMERS, trackOneShot } from '../usage-ledger/recorder.ts';
import { oneShotAccountRef } from '../usage-ledger/identity.ts';
import { resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';

/**
 * A shell check cannot read a prompt, so Settings → Global instructions reach it through one cheap
 * model call made just before it runs: the namer model reads the instructions, the command and the
 * files the task changed, and answers with the command to run — the same one when nothing conflicts.
 * An independent call, not the task's agent, so the agent under test never rewrites its own gate.
 * Never throws and never blocks: any failure runs the command as written.
 */

const COMMAND_MAX = 4_000;
const FILES_MAX = 200;

export const CHECK_INSTRUCTIONS_SYSTEM_PROMPT =
  'You decide which shell command a cezar workflow check step runs, so that it follows the global instructions ' +
  'above. You get the step\'s command and the files the task changed. When the instructions ask for something ' +
  'the command does not do (for example: run only the checks related to the change), answer with the command ' +
  'adjusted to do it, still checking the same thing — tests stay tests, lint stays lint — and still exiting ' +
  'non-zero on failure. When nothing conflicts, or you are unsure, answer with the command unchanged. Never ' +
  'make a check that cannot fail, never add network, publish, push or delete commands. Respond with ONLY a JSON ' +
  'object: {"command": string, "reason": string} — reason is one short sentence.';

const answerSchema = z.object({ command: z.string(), reason: z.string().optional() });

/** `changed` → run `command` instead, for `reason`; else run it as written, `note` saying why when worth it. */
export type CheckCommandResolution = { command: string; changed: boolean; reason?: string; note?: string };

/** `CEZ_CHECK_INSTRUCTIONS=0` turns the call off; dry-run makes none unless it is `1`. */
export function checkInstructionsActive(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CEZ_CHECK_INSTRUCTIONS === '0') return false;
  if (env.CEZ_DRY_RUN === '1' && env.CEZ_CHECK_INSTRUCTIONS !== '1') return false;
  return true;
}

export function buildCheckInstructionsPrompt(command: string, changedFiles: string[]): string {
  const files = changedFiles.slice(0, FILES_MAX);
  return [
    `Check command:\n${command}`,
    files.length
      ? `Files the task changed${changedFiles.length > files.length ? ` (first ${files.length} of ${changedFiles.length})` : ''}:\n${files.join('\n')}`
      : 'Files the task changed: none known.',
  ].join('\n\n');
}

/** The model's answer → the command to run, or undefined to keep the original. */
export function parseCheckCommandAnswer(raw: string): { command: string; reason?: string } | undefined {
  const parsed = parseStructured(raw, answerSchema);
  const command = parsed?.command.trim();
  if (!command || command.length > COMMAND_MAX) return undefined;
  const reason = parsed?.reason?.trim().split('\n')[0]?.slice(0, 300);
  return { command, ...(reason ? { reason } : {}) };
}

/**
 * The command a check runs under the current global instructions. As written when there are none,
 * the call is off, the default runner has no cheap model, or the answer is unusable.
 */
export async function resolveCheckCommand(input: {
  repoRoot: string;
  command: string;
  /** What the task changed (`worktreeChangedFiles`); null when unknown. */
  changedFiles: string[] | null;
  instructions?: string;
}): Promise<CheckCommandResolution> {
  const asWritten = (note?: string): CheckCommandResolution => ({ command: input.command, changed: false, ...(note ? { note } : {}) });
  const instructions = input.instructions ?? readGlobalInstructions();
  if (!instructions || !checkInstructionsActive()) return asWritten();
  try {
    const config = await loadConfig(input.repoRoot);
    const choice = await resolveNamerModel(config.defaultRunner, config);
    if (!choice) return asWritten(`global instructions: no cheap model for ${config.defaultRunner} to apply them, so this check runs as written`);
    const runner = createRunner(config.defaultRunner);
    const { env, profile } = await resolveProfileEnvForRoot(input.repoRoot, config.defaultRunner);
    const tracked = trackOneShot(config.defaultRunner, await oneShotAccountRef(config.defaultRunner, profile), INTERNAL_CONSUMERS.checks);
    let result: Awaited<ReturnType<typeof runner.run>> | undefined;
    try {
      result = await runner.run({
        // Named here too, so the call is self-contained; `createRunner` sees their text and adds no second copy.
        systemPrompt: `## Global instructions\n\n${instructions}\n\n---\n\n${CHECK_INSTRUCTIONS_SYSTEM_PROMPT}`,
        userPrompt: buildCheckInstructionsPrompt(input.command, input.changedFiles ?? []),
        cwd: input.repoRoot,
        allowedTools: [],
        model: choice.model,
        ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
        timeoutMs: NAMER_TIMEOUT_MS,
        env: { ...env, CEZ_MOCK_ARGS_FILE: '' },
      }, tracked.onEvent);
    } finally {
      tracked.done(result);
    }
    const answer = parseCheckCommandAnswer(result.text);
    if (!answer) return asWritten('global instructions: no usable answer about this check, so it runs as written');
    if (answer.command === input.command.trim()) return asWritten('global instructions: nothing to change in this check');
    return { command: answer.command, changed: true, reason: answer.reason ?? 'no reason given' };
  } catch (err) {
    return asWritten(`global instructions: could not apply them to this check (${err instanceof Error ? err.message : String(err)}), so it runs as written`);
  }
}
