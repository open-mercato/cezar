import { readUiState } from './ui-state.ts';

/**
 * Promotes `open-mercato/skills` (#391) — cezar's built-in default skills source
 * (`DEFAULT_SKILLS_REPOS` in `src/config.ts`) that today only surfaces in `--help`. Split out of
 * `src/index.ts` so it is testable without importing `index.ts` (which runs `main()` on import).
 * It once had a cockpit twin to stay in step with; #603 replaced that with the opt-in
 * `packages/web/src/components/skills-import-panel.tsx`, so the terminal is now the only surface
 * that renders the promo.
 *
 * Printed on `serve` start — a few lines in an already-chatty startup block. It has two off
 * switches, because a promo that cannot be silenced is a nag:
 *  - `CEZ_NO_BANNER=1` in the environment, and
 *  - `dismissedSkillsBanner` in `.ai/cezar/ui-state.json` — written by the cockpit banner until
 *    #603 removed it. The flag is still honoured, so anyone who dismissed it back then stays
 *    silenced; nothing writes it today.
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
