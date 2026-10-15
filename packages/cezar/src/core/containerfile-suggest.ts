/**
 * Learn a repo's container image from what its agents actually installed.
 *
 * A repo with no `Containerfile` runs on the generic base, so the first task in
 * it spends its opening minutes installing a toolchain — and the task after
 * that does it again, because the container is per task. The commands it ran
 * are already in the run's event log; this turns them into the image, so the
 * cost is paid once.
 *
 * Two rules decide what counts, and both matter more than the parsing:
 *
 *  1. **Only SYSTEM-wide installs.** `npm install` inside the repo resolves the
 *     project's own lockfile — that belongs to the worktree and to `pnpm`, not
 *     to the image, and baking it in would produce an image that is stale the
 *     moment a dependency changes. `npm i -g typescript` or
 *     `apt-get install python3.7` is a toolchain, and that is what an image is
 *     for.
 *  2. **Suggest, never apply.** A Containerfile assembled from whatever a model
 *     happened to type is not something to write behind someone's back. The
 *     output here is a proposal a human reads and accepts.
 */

/** One install cezar noticed, kept with its provenance so the UI can explain it. */
export interface InstallSuggestion {
  /** The normalized command to put in the image. */
  command: string;
  /** The package manager it came from, for grouping in the UI. */
  manager: 'apt' | 'npm' | 'pnpm' | 'yarn' | 'pip' | 'pipx' | 'go' | 'cargo' | 'gem' | 'apk' | 'dnf';
}

/**
 * Package managers whose "install globally" spelling we recognise. Each entry
 * matches the command form that changes the MACHINE, never the one that
 * installs a project's own dependencies — see rule 1.
 */
const MATCHERS: Array<{ manager: InstallSuggestion['manager']; re: RegExp }> = [
  // Debian/Ubuntu. `-y` and flag order vary; the package list is what matters.
  { manager: 'apt', re: /\bapt(?:-get)?\s+(?:-[^\s]+\s+)*install\s+(?<pkgs>[^&|;]+)/ },
  { manager: 'apk', re: /\bapk\s+add\s+(?:--no-cache\s+)?(?<pkgs>[^&|;]+)/ },
  { manager: 'dnf', re: /\b(?:dnf|yum)\s+install\s+(?:-y\s+)?(?<pkgs>[^&|;]+)/ },
  // Node: only the GLOBAL forms. `npm install` (no -g) is the project's own deps.
  { manager: 'npm', re: /\bnpm\s+(?:i|install|add)\s+(?:[^\s]*\s+)*?(?:-g|--global)\s+(?<pkgs>[^&|;]+)/ },
  { manager: 'npm', re: /\bnpm\s+(?:i|install|add)\s+(?<pkgs>[^&|;]*?)\s+(?:-g|--global)\b/ },
  { manager: 'pnpm', re: /\bpnpm\s+(?:add|install)\s+(?:[^\s]*\s+)*?(?:-g|--global)\s+(?<pkgs>[^&|;]+)/ },
  { manager: 'yarn', re: /\byarn\s+global\s+add\s+(?<pkgs>[^&|;]+)/ },
  // Python: pip inside a container IS system-wide.
  { manager: 'pip', re: /\b(?:pip3?|python3?\s+-m\s+pip)\s+install\s+(?:[^\s]*\s+)*?(?<pkgs>[^&|;]+)/ },
  { manager: 'pipx', re: /\bpipx\s+install\s+(?<pkgs>[^&|;]+)/ },
  { manager: 'go', re: /\bgo\s+install\s+(?<pkgs>[^&|;]+)/ },
  { manager: 'cargo', re: /\bcargo\s+install\s+(?<pkgs>[^&|;]+)/ },
  { manager: 'gem', re: /\bgem\s+install\s+(?<pkgs>[^&|;]+)/ },
];

/** Flags that are not packages, so they never reach the image as if they were. */
const NOT_A_PACKAGE = /^(-|--)|^\.$|^\.\//;

/**
 * `pip install -r requirements.txt` and friends install the PROJECT's
 * dependencies, exactly like a bare `npm install`. They belong to the repo, not
 * to the image.
 */
const PROJECT_SCOPED = /(?:^|\s)(?:-r|--requirement|-e|--editable)(?:\s|$)/;

/**
 * What a package token may look like once it is written into a `RUN` line.
 *
 * A POSITIVE charset rather than a list of things to reject: anything here is
 * pasted into a shell inside a Containerfile, and a stray `>`, `&`, `|`, quote
 * or `$` there is a syntax error that fails the image build — before every
 * later task, each of which then falls back to the host. Version constraints
 * with comparison operators (`foo>=1.2`) are the cost: they lose the
 * constraint, keeping the package, which is the right way round.
 */
const PACKAGE_TOKEN = /^[A-Za-z0-9@][A-Za-z0-9._+\-/:=@~^]*$/;

function splitPackages(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !NOT_A_PACKAGE.test(p) && PACKAGE_TOKEN.test(p));
}

/**
 * Remove shell redirections, so what is left is words and operators.
 *
 * `apt-get install -y foo 2>&1 | tail` used to become
 * `RUN … install -y foo 2> && rm -rf …` — the redirection split across a clause
 * boundary. Stripped first, then split on operators, the install is just `foo`.
 */
function stripRedirections(command: string): string {
  return command.replace(/\s*\d*(?:>>|>|<)(?:&\d+|\s*[^\s|;&]+)?/g, ' ');
}

/**
 * Pull the system-wide installs out of one shell command. A command may chain
 * several (`apt-get update && apt-get install -y git curl`), so every matcher
 * is applied to every `&&`/`;`-separated clause.
 */
export function extractInstalls(command: string): InstallSuggestion[] {
  const out: InstallSuggestion[] = [];
  // `sudo` is noise inside a container, where the agent is already root.
  // Redirections out first, then split on EVERY control operator — pipes and
  // `&` included, so `… | tail` is its own clause instead of package names.
  const clauses = stripRedirections(command)
    .split(/&&|\|\||;|\||&/)
    .map((c) => c.trim().replace(/^sudo\s+/, ''));
  for (const clause of clauses) {
    if (PROJECT_SCOPED.test(clause)) continue;
    for (const { manager, re } of MATCHERS) {
      const m = re.exec(clause);
      const pkgs = m?.groups?.pkgs;
      if (!pkgs) continue;
      const list = splitPackages(pkgs);
      if (list.length === 0) continue;
      out.push({ manager, command: renderInstall(manager, list) });
      break; // one manager per clause; the first match is the verb that ran
    }
  }
  return out;
}

/** The canonical, non-interactive spelling of an install for a Containerfile. */
export function renderInstall(manager: InstallSuggestion['manager'], packages: string[]): string {
  const pkgs = packages.join(' ');
  switch (manager) {
    case 'apt':
      // Non-interactive and cache-cleaning, because a Containerfile that
      // prompts hangs the build and one that keeps lists bloats the image.
      return `apt-get update && apt-get install -y --no-install-recommends ${pkgs} && rm -rf /var/lib/apt/lists/*`;
    case 'apk':
      return `apk add --no-cache ${pkgs}`;
    case 'dnf':
      return `dnf install -y ${pkgs}`;
    case 'npm':
      return `npm install -g ${pkgs}`;
    case 'pnpm':
      return `pnpm add -g ${pkgs}`;
    case 'yarn':
      return `yarn global add ${pkgs}`;
    case 'pip':
      return `pip install --no-cache-dir ${pkgs}`;
    case 'pipx':
      return `pipx install ${pkgs}`;
    case 'go':
      return `go install ${pkgs}`;
    case 'cargo':
      return `cargo install ${pkgs}`;
    case 'gem':
      return `gem install ${pkgs}`;
  }
}

/** Dedupe, keeping first-seen order so the file reads like the work happened. */
export function mergeSuggestions(existing: InstallSuggestion[], found: InstallSuggestion[]): InstallSuggestion[] {
  const seen = new Set(existing.map((s) => s.command));
  const out = [...existing];
  for (const s of found) {
    if (seen.has(s.command)) continue;
    seen.add(s.command);
    out.push(s);
  }
  return out;
}

/**
 * Render the proposal as a Containerfile. It builds FROM the base image cezar
 * ships, so the agent CLI, git and gh are inherited rather than restated, and
 * the repo's file only ever describes what is peculiar to the repo.
 */
export function renderContainerfile(suggestions: InstallSuggestion[], base = 'localhost/cezar-agent/base:latest'): string {
  const lines = [
    '# Generated by cezar from what this project\'s agents installed.',
    '# Review it like any other file: it was assembled from commands a model ran.',
    '# Rebuilt automatically when this file changes — the NEXT task picks it up,',
    '# never the one running now, whose container already has these tools.',
    `FROM ${base}`,
    '',
  ];
  for (const s of suggestions) lines.push(`RUN ${s.command}`);
  return `${lines.join('\n')}\n`;
}
