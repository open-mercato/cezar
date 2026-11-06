import { loadConfig } from '../config.ts';
import { resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.ts';

/** The quick task has no model override: like the engine, leave native model selection alone.
 * Composer model presets are not engine defaults and must not become Telegram overrides.
 * Only the selected account's execution identity matters, not its label or unrelated accounts. */
export async function prepareTelegramTaskTarget(root: string) {
  const { defaultRunner: runner } = await loadConfig(root);
  const { profile } = await resolveProfileEnvForRoot(root, runner);
  return { workflow: QUICK_TASK_WORKFLOW.name, runner, account: { id: profile.id, path: profile.path } };
}
export type TelegramTaskTarget = Awaited<ReturnType<typeof prepareTelegramTaskTarget>>;
export async function telegramTaskTargetCurrent(root: string, target: TelegramTaskTarget): Promise<boolean> {
  return JSON.stringify(await prepareTelegramTaskTarget(root)) === JSON.stringify(target);
}
