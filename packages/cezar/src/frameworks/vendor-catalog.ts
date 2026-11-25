/**
 * Vendor knowledge for the provisional built-in frameworks (spec 2026-11-15-framework-board,
 * "OpenSpec, spec-kit"). Command names and paths belong to other projects and drift; keep them
 * here, dated, and re-check before promoting a template out of `provisional`.
 *
 * Checked: 2026-11-23, from the spec's mockups and the vendors' READMEs as last known.
 */

export const OPENSPEC = {
  checked: '2026-11-23',
  /** `openspec init` writes this file. */
  detect: ['openspec/project.md'],
  commands: {
    proposal: '/openspec:proposal',
    apply: '/openspec:apply',
    archive: '/openspec:archive',
  },
} as const;

export const SPEC_KIT = {
  checked: '2026-11-23',
  /** `specify init` creates this directory; it is shown to the user, never run by cezar. */
  detect: ['.specify'],
  setup: 'uvx --from git+https://github.com/github/spec-kit.git specify init --here',
  commands: {
    constitution: '/speckit.constitution',
    specify: '/speckit.specify',
    clarify: '/speckit.clarify',
    plan: '/speckit.plan',
    tasks: '/speckit.tasks',
    analyze: '/speckit.analyze',
    implement: '/speckit.implement',
  },
} as const;

/**
 * Open Mercato SDD's own installer (`node install.mjs <repo>`, README "Install"), pinned to one
 * commit so a click never runs a script nobody reviewed. Checked 2026-11-24 at `04ba2cc`.
 */
export const OPEN_MERCATO_SDD_INSTALL = {
  checked: '2026-11-24',
  name: 'Open Mercato SDD',
  repo: 'https://github.com/open-mercato/sdd.git',
  /** Shown in the confirm dialog. */
  label: 'open-mercato/sdd',
  ref: '04ba2cc1102a1157f55091c8941544bb721e0253',
  installer: 'install.mjs',
  /** What the installer writes; a trailing `/` is a directory, `*` a glob. */
  writes: ['.claude/skills/om-sdd*/', '.ai/sdd/', '.ai/agentic.config.json'],
  /** Exists once installed: re-installing over it with local changes is refused. */
  marker: '.ai/sdd/sdd.mjs',
} as const;
