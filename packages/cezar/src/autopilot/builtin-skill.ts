/**
 * Built-in Self-Heal skill — ships with the binary, gated on capabilities.autopilot + CEZ_API_URL.
 */
import { resolveCapabilities } from '../server/capabilities.ts';
import type { Skill } from '../skills.ts';
import { SELF_HEAL_SKILL_BODY, SELF_HEAL_SKILL_NAME } from './prompts.ts';

export function autopilotReachable(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCapabilities(env).autopilot && Boolean(env.CEZ_API_URL);
}

export const SELF_HEAL_SKILL: Skill = {
  name: SELF_HEAL_SKILL_NAME,
  description:
    'Run a Self-Heal cycle: scout issues or failing checks, fan out fix candidates via cez task create, verify with engine checks, review, open a draft PR. Never merges.',
  body: SELF_HEAL_SKILL_BODY,
  path: `builtin:${SELF_HEAL_SKILL_NAME}`,
  source: 'builtin',
};

export function autopilotBuiltinSkills(env: NodeJS.ProcessEnv = process.env): Skill[] {
  return autopilotReachable(env) ? [{ ...SELF_HEAL_SKILL }] : [];
}
