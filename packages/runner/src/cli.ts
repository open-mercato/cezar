#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { detectBackends } from './backend-detect.js';
import { RunnerDaemon, type RunnerDaemonConfig } from './runner-daemon.js';

const USAGE = `cezar-runner — Cezar agent runner (managed cloud / self-hosted)

Usage:
  cezar-runner login
      Check that the \`claude\` / \`codex\` CLIs are on PATH and report which
      backends this host can serve. Advises which \`<tool> login\` to run.

  cezar-runner start --url <saas-base-url> --token <runner-token> [options]
      --backends <csv>           backends to advertise (default: anthropic-api
                                 for --kind cloud; auto-detected for
                                 self-hosted)
      --kind <k>                 cloud | self-hosted   (default: self-hosted)
      --concurrency <n>          max concurrent jobs   (default: 1)
      --poll-interval <s>        seconds between claim attempts (default: 1)
      --inherit-host-github      runner mints its own GitHub token from
                                 \`gh auth token\` / GITHUB_TOKEN; central
                                 mints nothing for these runs. Also settable
                                 via CEZAR_RUNNER_INHERIT_HOST_GITHUB=1.
      --github-installation-id <id>
                                 advertise a per-runner GitHub App install id
                                 (mutually exclusive with --inherit-host-github;
                                 the latter wins). Also settable via
                                 CEZAR_RUNNER_GITHUB_INSTALLATION_ID.

  cezar-runner help
      Show this help.

The runner token comes from Settings → Runners (shown once). It is stored
hashed on the server; treat it like a password.`;

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(USAGE);
    return;
  }

  if (sub === 'login') {
    const checks = await detectBackends();
    let anyAvailable = false;
    for (const c of checks) {
      if (c.available) {
        anyAvailable = true;
        console.log(`✓ ${c.backend.padEnd(11)} — ${c.binary} ${c.version ?? ''}`.trimEnd());
        console.log(`    ${c.hint}`);
      } else {
        console.log(`✗ ${c.backend.padEnd(11)} — ${c.hint}`);
      }
    }
    if (!anyAvailable) {
      console.error(
        '\nNo subscription-CLI backends available. Install `claude` and/or `codex`, then re-run.',
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      '\nAt least one backend is available. Start the runner with `cezar-runner start --url ... --token ...`.',
    );
    return;
  }

  if (sub === 'start') {
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: {
        url: { type: 'string' },
        token: { type: 'string' },
        backends: { type: 'string' },
        kind: { type: 'string' },
        concurrency: { type: 'string' },
        'poll-interval': { type: 'string' },
        'inherit-host-github': { type: 'boolean' },
        'github-installation-id': { type: 'string' },
      },
    });
    const url = values.url ?? process.env.CEZAR_RUNNER_URL;
    const token = values.token ?? process.env.CEZAR_RUNNER_TOKEN;
    if (!url || !token) {
      console.error(
        'cezar-runner start: --url and --token are required (or set CEZAR_RUNNER_URL / CEZAR_RUNNER_TOKEN).',
      );
      process.exitCode = 1;
      return;
    }
    const kind: RunnerDaemonConfig['kind'] = values.kind === 'cloud' ? 'cloud' : 'self-hosted';

    let backends: string[];
    if (values.backends) {
      backends = values.backends
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (kind === 'cloud') {
      backends = ['anthropic-api'];
    } else {
      const checks = await detectBackends();
      backends = checks.filter((c) => c.available).map((c) => c.backend);
      if (backends.length === 0) {
        console.error(
          'No backends auto-detected for a self-hosted runner. Pass --backends explicitly (e.g. --backends claude-cli) or run `cezar-runner login`.',
        );
        process.exitCode = 1;
        return;
      }
    }

    // ── Per-runner GitHub identity (Phase 4) ──
    // Both modes mutually exclusive; inherit-host wins (matches server-side
    // precedence in /api/runner/jobs).
    const inheritHostGithub =
      Boolean(values['inherit-host-github']) ||
      process.env.CEZAR_RUNNER_INHERIT_HOST_GITHUB === '1';
    let githubInstallationId: number | null = null;
    if (!inheritHostGithub) {
      const raw =
        values['github-installation-id'] ?? process.env.CEZAR_RUNNER_GITHUB_INSTALLATION_ID;
      if (raw && raw.trim()) {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
          console.error(
            `cezar-runner start: --github-installation-id must be a positive integer (got '${raw}')`,
          );
          process.exitCode = 1;
          return;
        }
        githubInstallationId = n;
      }
    } else if (
      values['github-installation-id'] ||
      process.env.CEZAR_RUNNER_GITHUB_INSTALLATION_ID
    ) {
      console.warn(
        '[cezar-runner] --inherit-host-github overrides --github-installation-id (host wins).',
      );
    }

    const daemon = new RunnerDaemon({
      url,
      token,
      backends,
      kind,
      concurrency: values.concurrency ? Number(values.concurrency) : undefined,
      pollIntervalSec: values['poll-interval'] ? Number(values['poll-interval']) : undefined,
      githubInheritHost: inheritHostGithub,
      githubInstallationId,
    });
    await daemon.start();
    return;
  }

  console.error(`cezar-runner: unknown command '${sub}'\n`);
  console.log(USAGE);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('[cezar-runner] fatal:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
