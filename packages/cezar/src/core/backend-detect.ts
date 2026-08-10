import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface BackendCheck {
  name: 'claude' | 'codex' | 'opencode' | 'gh' | 'git';
  available: boolean;
  version?: string;
  hint?: string;
}

/**
 * Probe the host for everything cez leans on: the agent CLIs (`claude`, and
 * the optional `codex` / `opencode` alternatives), `gh` (GitHub auth for PR
 * creation) and `git`. Nothing is required except at least one agent CLI — the
 * GUI degrades gracefully, only offers the runners that are present, and shows
 * the hints for the rest.
 */
export async function detectEnvironment(): Promise<BackendCheck[]> {
  return Promise.all([probeClaude(), probeCodex(), probeOpencode(), probeGh(), probeGit()]);
}

async function probeClaude(): Promise<BackendCheck> {
  if (process.env.CEZ_DRY_RUN === '1') {
    return { name: 'claude', available: true, version: 'mock (CEZ_DRY_RUN=1)' };
  }
  // `CEZ_CLAUDE_BIN` like every other claude call site (the runner, provider-auth,
  // open-in-app). Probing a bare `claude` reported "not installed" for a host whose
  // only install is at a custom path — which drops claude from the composer and the
  // installer's dependency step even though runs would have worked fine.
  const bin = process.env.CEZ_CLAUDE_BIN ?? 'claude';
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
