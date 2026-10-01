import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCursorAgentBin } from './cursor-agent-runner.ts';
import { resolveClaudeBin } from './claude-bin.ts';

const exec = promisify(execFile);

export interface BackendCheck {
  name: 'claude' | 'codex' | 'opencode' | 'cursor' | 'pi' | 'gh' | 'glab' | 'git';
  available: boolean;
  version?: string;
  hint?: string;
}

/**
 * Probe the host for everything cez leans on: the agent CLIs (`claude`, and
 * the optional `codex` / `opencode` / `cursor` / `pi` alternatives), `gh` (GitHub
 * auth for PR creation), `glab` (GitLab auth for merge-request creation — spec
 * 2026-08-10-forge-provider-adapters) and `git`. Nothing is required except at
 * least one agent CLI — the GUI degrades gracefully, only offers the runners
 * that are present, and shows the hints for the rest. `glab` in particular is
 * optional in every sense: a GitHub-only project never needs it, so its
 * absence is never an error and never fails boot (AGENTS.md "Zero config").
 */
export async function detectEnvironment(): Promise<BackendCheck[]> {
  return Promise.all([
    probeClaude(),
    probeCodex(),
    probeOpencode(),
    probeCursor(),
    probePi(),
    probeGh(),
    probeGlab(),
    probeGit(),
  ]);
}

async function probeClaude(): Promise<BackendCheck> {
  if (process.env.CEZ_DRY_RUN === '1') {
    return { name: 'claude', available: true, version: 'mock (CEZ_DRY_RUN=1)' };
  }
  // Resolve the binary like every other claude call site (the runner, provider-auth,
  // open-in-app): `CEZ_CLAUDE_BIN`, PATH, then the installers' known locations. Probing a
  // bare `claude` reported "not installed" for a host whose only install is at a custom
  // path or in `~/.local/bin` off this process's PATH — which drops claude from the
  // composer and the installer's dependency step even though runs would have worked fine.
  const bin = resolveClaudeBin();
  try {
    const { stdout } = await exec(bin, ['--version'], { timeout: 10_000 });
    const version = stdout.trim();
    // A generic `claude` binary (a shell wrapper, an unrelated tool) can shadow
    // the real CLI on $PATH — reject anything that doesn't match the banner.
    if (!/^\d+\.\d+|^claude(\s+code)?\s+version\s+\d+\.\d+/i.test(version)) {
      return {
        name: 'claude',
        available: false,
        hint: `\`${bin}\` resolves but doesn't look like Claude Code (got: ${version.slice(0, 80)})`,
      };
    }
    return {
      name: 'claude',
      available: true,
      version,
      hint: 'if not authenticated, run `claude` once and log in',
    };
  } catch {
    return {
      name: 'claude',
      available: false,
      // npm, to match what cezar's own installer runs (`server-install/steps.ts`, `NPM_GLOBAL`)
      // and what the cockpit's accounts panel tells users — and because it is the one route
      // that works on every platform this runs on.
      hint: 'install Claude Code (npm i -g @anthropic-ai/claude-code) and log in',
    };
  }
}

async function probeCodex(): Promise<BackendCheck> {
  const bin = process.env.CEZ_CODEX_BIN ?? 'codex';
  try {
    const { stdout } = await exec(bin, ['--version'], { timeout: 10_000 });
    return {
      name: 'codex',
      available: true,
      version: stdout.trim(),
      hint: 'if not authenticated, run `codex` once and log in',
    };
  } catch {
    return {
      name: 'codex',
      available: false,
      hint: 'optional: install the Codex CLI (npm i -g @openai/codex) and log in to use the Codex runner',
    };
  }
}

async function probeOpencode(): Promise<BackendCheck> {
  const bin = process.env.CEZ_OPENCODE_BIN ?? 'opencode';
  try {
    const { stdout } = await exec(bin, ['--version'], { timeout: 10_000 });
    return {
      name: 'opencode',
      available: true,
      version: stdout.trim(),
      hint: 'if no provider is configured, run `opencode` once to set one up',
    };
  } catch {
    return {
      name: 'opencode',
      available: false,
      hint: 'optional: install OpenCode (https://opencode.ai) and configure a provider to use the OpenCode runner',
    };
  }
}

async function probeCursor(): Promise<BackendCheck> {
  if (process.env.CEZ_DRY_RUN === '1') {
    return { name: 'cursor', available: true, version: 'mock (CEZ_DRY_RUN=1)' };
  }
  const bin = resolveCursorAgentBin();
  try {
    const { stdout } = await exec(bin, ['--version'], { timeout: 10_000 });
    return {
      name: 'cursor',
      available: true,
      version: stdout.trim() || 'installed',
      hint: 'if not authenticated, run `agent login` or set CURSOR_API_KEY',
    };
  } catch {
    return {
      name: 'cursor',
      available: false,
      hint: 'optional: install the Cursor CLI (curl https://cursor.com/install -fsS | bash) and run `agent login`',
    };
  }
}

async function probePi(): Promise<BackendCheck> {
  // Dry-run stands the runner up on the shared mock, so report it present.
  if (process.env.CEZ_DRY_RUN === '1') {
    return { name: 'pi', available: true, version: 'mock (CEZ_DRY_RUN=1)' };
  }
  const bin = process.env.CEZ_PI_BIN ?? 'pi';
  try {
    const { stdout } = await exec(bin, ['--version'], { timeout: 10_000 });
    return {
      name: 'pi',
      available: true,
      version: stdout.trim(),
      hint: 'if not authenticated, run `pi` once and log in',
    };
  } catch {
    // A missing `pi` CLI is never a boot failure — the runner just isn't
    // offered, exactly like an absent codex/opencode.
    return {
      name: 'pi',
      available: false,
      hint: 'optional: install the pi CLI and log in to use the pi runner',
    };
  }
}

async function probeGh(): Promise<BackendCheck> {
  try {
    const { stdout } = await exec('gh', ['auth', 'token'], { timeout: 10_000 });
    return { name: 'gh', available: stdout.trim().length > 0, version: 'authenticated' };
  } catch {
    return {
      name: 'gh',
      available: false,
      hint: 'install the GitHub CLI and run `gh auth login` (only needed for PR creation)',
    };
  }
}

/** How long the `glab` probe may take IN TOTAL: its two reads share this one budget, so the
 *  worst case is this number and not twice it. `detectEnvironment` feeds `healthSnapshot`, and a
 *  snapshot older than `HEALTH_MAX_STALE_MS` makes `GET /api/v1/health` WAIT for this — the
 *  bookmarklet's latency budget (CODE_REVIEW.md priority 2). Local reads answer in milliseconds;
 *  this is only the ceiling for a pathological host. */
const GLAB_PROBE_TIMEOUT_MS = 2_500;

/** `glab`'s own version notifier is its one network touch on an otherwise local command; off, so
 *  an offline host cannot spend the probe's budget on it. */
const GLAB_PROBE_ENV = { ...process.env, GLAB_CHECK_UPDATE: 'false' };

/**
 * The GitLab equivalent of `probeGh`'s `gh auth token`, and deliberately the same SHAPE: a LOCAL
 * config read, never `glab auth status`. `auth status` validates the token against every
 * configured host over the NETWORK, and this probe runs on the health request path — offline, it
 * would hold `/api/v1/health` open until its timeout, which reads as "cez is down" (AGENTS.md: a
 * missing dependency degrades, never blocks). Live GitLab authentication is the off-path discovery
 * warm-up's job (`server/forge/discovery.ts` rung 3), which does run `glab auth status`.
 *
 * Two local reads, because `glab config get token` without `--host` only sees the environment:
 * the default host (which also proves `glab` is installed and runnable), then that host's token.
 * `glab`'s lookup order is environment → local → global, so a `GITLAB_TOKEN` in the environment
 * counts as authenticated exactly as `glab` itself would count it. They run against ONE deadline,
 * not one timeout each: two sequential reads with the full budget apiece would put the health
 * route's worst case at twice the number the budget was sized for.
 *
 * What this can and cannot see: it answers "is a credential configured for the host `glab` would
 * use by default", not "is that credential still valid" — a revoked or expired token still reads
 * as authenticated, and a user logged in ONLY to a self-managed host that is not their default
 * reads as not authenticated. Both are the right trade for a check whose answer is a hint.
 * ENOENT (glab not installed) lands in the same `catch` as a config read that fails, exactly like
 * every other optional CLI here and exactly as before: no distinction is drawn between "not
 * installed" and "not authenticated" (spec 2026-08-10-forge-provider-adapters, D6).
 */
async function probeGlab(): Promise<BackendCheck> {
  try {
    const deadline = Date.now() + GLAB_PROBE_TIMEOUT_MS;
    const { stdout: host } = await exec('glab', ['config', 'get', 'host'], glabProbeOptions(deadline));
    const { stdout: token } = await exec(
      'glab',
      ['config', 'get', 'token', '--host', host.trim() || 'gitlab.com'],
      glabProbeOptions(deadline),
    );
    if (!token.trim()) throw new Error('no token configured');
    return { name: 'glab', available: true, version: 'authenticated' };
  } catch {
    return {
      name: 'glab',
      available: false,
      hint: 'optional: install the GitLab CLI and run `glab auth login` (only needed for GitLab projects)',
    };
  }
}

/** One probe read's options: whatever is left of the pair's shared budget. Never 0 — `execFile`
 *  reads a timeout of 0 as "no timeout at all", the exact opposite of a spent budget. */
function glabProbeOptions(deadline: number): { timeout: number; env: NodeJS.ProcessEnv } {
  return { timeout: Math.max(1, deadline - Date.now()), env: GLAB_PROBE_ENV };
}

async function probeGit(): Promise<BackendCheck> {
  try {
    const { stdout } = await exec('git', ['--version'], { timeout: 10_000 });
    return { name: 'git', available: true, version: stdout.trim() };
  } catch {
    return { name: 'git', available: false, hint: 'install git' };
  }
}

/** The host's GitHub token: logged-in `gh` first, `GITHUB_TOKEN` fallback. */
export async function readHostGithubToken(): Promise<string | null> {
  try {
    const { stdout } = await exec('gh', ['auth', 'token'], { timeout: 10_000 });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // fall through to the env var
  }
  return process.env.GITHUB_TOKEN?.trim() || null;
}
