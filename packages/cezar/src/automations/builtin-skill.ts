/**
 * The built-in `create-cezar-automation` skill (spec `.ai/specs/2026-09-13-automations-from-prompt.md`).
 *
 * cezar ships no skill files of its own — every skill is discovered from the repo, the `npx
 * skills` dirs or a team repo — and this is the one deliberate exception: the playbook for
 * turning a prompt into a GitHub automation belongs to the cockpit that runs the automations, not
 * to a repository. It is a TypeScript constant rather than a Markdown file in the tarball so the
 * pack gate, the `files` list and the discovery walk stay exactly what they were.
 *
 * Gated like everything else an agent is TOLD about automations (`automationsReachable`): the
 * skill lists only on a cockpit that has automations on AND can be reached over `CEZ_API_URL` — a
 * headless `cezar run` or a cockpit with the flag off would hand the agent a playbook whose every
 * command is refused. Lowest precedence in the catalog: a repo that ships its own skill of this
 * name wins ("the user's repo is the source of truth").
 */
import { resolveCapabilities } from '../server/capabilities.ts';
import type { Skill } from '../skills.ts';
import { CREATE_AUTOMATION_SKILL_BODY, CREATE_AUTOMATION_SKILL_NAME } from './prompts.ts';

/**
 * Can a task actually USE automations? The flag alone is not enough: `CEZ_API_URL` is set by
 * `serveCommand`, so a headless run has no cockpit to call. The one predicate behind the built-in
 * skill and the always-on prompt part (`RunManager.prepareAutomationsSession`).
 */
export function automationsReachable(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCapabilities(env).automations && Boolean(env.CEZ_API_URL);
}

export const CREATE_AUTOMATION_SKILL: Skill = {
  name: CREATE_AUTOMATION_SKILL_NAME,
  description:
    'Turn a request like "whenever a PR is opened, review it" into a GitHub automation on this cockpit — the trigger, its filters and the task it launches — created paused, previewed, and linked.',
  // An automation is authored, not coded: nothing to isolate in a worktree, and the agent may
  // have to ask which label or event the user meant — the interactive, in-place composer default.
  interactive: true,
  body: CREATE_AUTOMATION_SKILL_BODY,
  path: `builtin:${CREATE_AUTOMATION_SKILL_NAME}`,
  source: 'builtin',
};

/** The built-in skills this process offers right now — empty unless automations are reachable. */
export function builtinSkills(env: NodeJS.ProcessEnv = process.env): Skill[] {
  return automationsReachable(env) ? [{ ...CREATE_AUTOMATION_SKILL }] : [];
}
