import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface BackendCheck {
  backend: 'claude-cli' | 'codex-cli';
  binary: string;
  available: boolean;
  version?: string;
  hint?: string;
}

/**
 * Probes which subscription-CLI backends this host can serve by spawning
 * `<bin> --version`. Does NOT verify the CLI is *logged in* (that needs an
 * interactive flow); callers print a "run `claude login` / `codex login`" hint.
 */
export async function detectBackends(): Promise<BackendCheck[]> {
  const probes: Array<{
    backend: BackendCheck['backend'];
    binary: string;
    loginCmd: string;
    versionRegex: RegExp;
  }> = [
    // The Anthropic Claude CLI prints e.g. `2.1.201 (Claude Code)` (≥2.x) or
    // `claude version 1.0.13` / `claude code version …` (older releases).
    {
      backend: 'claude-cli',
      binary: 'claude',
      loginCmd: 'claude login',
      versionRegex:
        /^(?:claude(?:\s+code)?\s+version\s+\d+\.\d+|\d+\.\d+\.\d+\s*\(claude\s+code\))/i,
    },
    // The Codex CLI prints e.g. `codex-cli 0.132.0` (or `codex 0.4.2` on older releases).
    {
      backend: 'codex-cli',
      binary: 'codex',
      loginCmd: 'codex login',
      versionRegex: /^codex(?:-cli)?\s+\d+\.\d+/i,
    },
  ];
  return Promise.all(
    probes.map(async ({ backend, binary, loginCmd, versionRegex }) => {
      try {
        const { stdout } = await exec(binary, ['--version'], { timeout: 10_000 });
        const version = stdout.trim();
        if (!versionRegex.test(version)) {
          // A generic `claude`/`codex` binary (a shell wrapper, an unrelated vendor tool)
          // shadows the real CLI on $PATH. Advertising it would make the daemon claim jobs
          // it can't run, thrashing the queue — reject anything that doesn't match the banner.
          return {
            backend,
            binary,
            available: false,
            hint: `\`${binary}\` is on PATH but doesn't look like the expected CLI (got: ${version.slice(0, 80)})`,
          };
        }
        return {
          backend,
          binary,
          available: true,
          version,
          hint: `if not authenticated, run \`${loginCmd}\``,
        };
      } catch {
        return {
          backend,
          binary,
          available: false,
          hint: `install the \`${binary}\` CLI and run \`${loginCmd}\``,
        };
      }
    }),
  );
}
