import { readUiState } from './ui-state.js';

/**
 * Promotes `open-mercato/skills` (#391) — cezar's built-in default skills source
 * (`DEFAULT_SKILLS_REPOS` in `src/config.ts`) that today only surfaces in `--help`. Split out of
 * `src/index.ts` so the CLI banner has one source of truth the web cockpit copy
 * (`web/app/src/components/skills-banner.tsx`) can be kept in step with, and so it is testable
 * without importing `index.ts` (which runs `main()` on import).
 *
 * Printed on `serve` start — a few lines in an already-chatty startup block. It has two off
 * switches, because a promo that cannot be silenced is a nag:
 *  - `CEZ_NO_BANNER=1` in the environment, and
 *  - `dismissedSkillsBanner` in `.ai/cezar/ui-state.json` — the SAME flag the cockpit banner
 *    persists, so dismissing it there also silences the terminal and the two surfaces tell one
 *    story.
 * Reading that flag follows the `src/config.ts` rule: a missing/unreadable/malformed state file
 * degrades to showing the banner, never to a crash or a blocked startup.
 */
export const SKILLS_BANNER_LINES: readonly string[] = [
  '  🤖 Make the most of parallel coding with our AI skills',
  '  open-mercato/skills: reusable, technology-agnostic agent skills for PR',
  '  creation, code review, CI stabilisation, spec writing & more.',
  '  cezar already loads them for you — Skills → Refresh in the cockpit gets the latest.',
  "  To use them outside cezar:  npx skills add open-mercato/skills --skill '*'",
];

/** Both off switches in one place. Never throws. */
export async function shouldShowSkillsBanner(repoRoot: string): Promise<boolean> {
  if (process.env.CEZ_NO_BANNER === '1') return false;
  const uiState = await readUiState(repoRoot);
  return uiState.dismissedSkillsBanner !== true;
}

/** The `serve` startup banner. `log` is injectable so the wiring is testable. */
export async function printSkillsBanner(
  repoRoot: string,
  log: (line?: string) => void = console.log,
): Promise<void> {
  if (!(await shouldShowSkillsBanner(repoRoot))) return;
  for (const line of SKILLS_BANNER_LINES) log(line);
  log();
}
