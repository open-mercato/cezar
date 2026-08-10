/**
 * The "no skills yet" copy shared by every empty state that tells a user where to drop skill
 * files — the Skills tab (`routes/skills.tsx`) and the workflow builder's skill palette
 * (`routes/workflows/workflows.tsx`). #374 (follow-up to #342): both used to mention only
 * `.ai/skills/`, while discovery also scans `.ai/cezar/skills/`, `.agents/skills/` (+ its
 * per-agent mirrors, e.g. `.claude/skills/`), the global `~/.agents/skills` /
 * `~/.claude/skills`, and the team skills repo (`src/skills.ts`). One shared list, so the two
 * SURFACES render the same copy.
 *
 * That is all this module can guarantee on its own: the list below is a hand-copy of the
 * server's actual discovery order, which lives in another process (`SKILL_DIRS` in
 * `src/skills.ts`) and cannot be imported into the bundle. `test/unit/skill-dirs.test.ts` pins
 * the server's list against the constant below, so adding a discovery dir there fails that
 * suite and points here instead of leaving this copy quietly wrong.
 */

/** Local project directories, in the server's precedence order — `src/skills.ts`'s SKILL_DIRS
 *  minus the per-agent mirrors (`.claude/skills` & co.), which the copy folds into one "agent
 *  mirrors like …" mention rather than listing five times. Pinned by
 *  `test/unit/skill-dirs.test.ts`; keep the two in step. */
const SKILL_PROJECT_DIRS = ['.ai/cezar/skills/', '.ai/skills/', '.agents/skills/'] as const

function Path({ children }: { children: string }) {
  return <span className="font-mono">{children}</span>
}

/** Renders `SKILL_PROJECT_DIRS` as "a, b, or c" with each entry in `<Path>`. */
function ProjectDirList() {
  return (
    <>
      {SKILL_PROJECT_DIRS.map((dir, index) => (
        <span key={dir}>
          {index > 0 ? (index === SKILL_PROJECT_DIRS.length - 1 ? ', or ' : ', ') : ''}
          <Path>{dir}</Path>
        </span>
      ))}
    </>
  )
}

/** Full copy — the Skills tab's empty list (room for the frontmatter aside + a Refresh hint). */
export function SkillEmptyHint() {
  return (
    <>
      No skills yet. Drop Markdown files into <ProjectDirList /> (agent mirrors like{' '}
      <Path>.claude/skills/</Path> work too) — optional frontmatter: <Path>name</Path>,{' '}
      <Path>description</Path>. Global (<Path>~/.agents/skills</Path>) and team-repo skills
      appear here too — try Refresh.
    </>
  )
}

/** Compact copy — the workflow builder's skill palette, where space is tighter and there is no
 *  Refresh action on the surface itself. */
export function SkillEmptyHintCompact() {
  return (
    <>
      No skills yet — drop Markdown files into <ProjectDirList /> (or a global/team-repo skill
      source).
    </>
  )
}
