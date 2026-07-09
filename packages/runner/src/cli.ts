#!/usr/bin/env node
import { parseArgs } from 'node:util';
import os from 'node:os';
import { detectBackends } from './backend-detect.js';
import {
  clearCredentials,
  defaultStateDir,
  readCredentials,
  registerWithJoinToken,
  writeCredentials,
} from './register.js';
import { RunnerDaemon, type RunnerDaemonConfig } from './runner-daemon.js';

const USAGE = `cezar-runner — Cezar agent runner (managed cloud / self-hosted)

Usage:
  cezar-runner login
      Check that the \`claude\` / \`codex\` CLIs are on PATH and report which
      backends this host can serve. Advises which \`<tool> login\` to run.

  cezar-runner start --url <saas-base-url> --join-token <join-token> [options]
      Registers this host with the join token (mint one in Settings →
      Runners) on first start, persists the resulting runner credential
      under ~/.cezar-runner/ and reuses it afterwards. The runner belongs
      to the user who minted the join token; jobs they request route to
      their runners.

      --join-token <t>           join token (or CEZAR_RUNNER_JOIN_TOKEN)
      --name <name>              runner name — (workspace, owner, name)
                                 identifies the runner; re-registering the
                                 same name re-keys it (default: hostname;
                                 or CEZAR_RUNNER_NAME)
      --token <runner-token>     DEPRECATED, removed in v0.3.0: pre-issued
                                 runner token (or CEZAR_RUNNER_TOKEN) — skips
                                 registration; migrate to --join-token
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

Mint a join token in Settings → Runners. Tokens are stored hashed on the
server; treat them like passwords. The registered credential persists in
~/.cezar-runner/ (override with CEZAR_RUNNER_STATE_DIR).`;

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
      '\nAt least one backend is available. Start the runner with `cezar-runner start --url ... --join-token ...`.',
    );
    return;
  }

  if (sub === 'start') {
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: {
        url: { type: 'string' },
        token: { type: 'string' },
        'join-token': { type: 'string' },
        name: { type: 'string' },
        backends: { type: 'string' },
        kind: { type: 'string' },
        concurrency: { type: 'string' },
        'poll-interval': { type: 'string' },
        'inherit-host-github': { type: 'boolean' },
        'github-installation-id': { type: 'string' },
      },
    });
    // `||` (not `??`) throughout: compose passes unset vars as empty strings.
    const url = values.url || process.env.CEZAR_RUNNER_URL;
    const explicitToken = values.token || process.env.CEZAR_RUNNER_TOKEN;
    const joinToken = values['join-token'] || process.env.CEZAR_RUNNER_JOIN_TOKEN;
    if (!url || (!explicitToken && !joinToken)) {
      console.error(
        'cezar-runner start: --url plus either --join-token or --token is required ' +
          '(or set CEZAR_RUNNER_URL / CEZAR_RUNNER_JOIN_TOKEN / CEZAR_RUNNER_TOKEN).',
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

    // ── Credential resolution ──
    // 1. an explicit --token / CEZAR_RUNNER_TOKEN wins (legacy pre-issued
    //    runners; nothing is persisted),
    // 2. else the credential persisted by a previous registration,
    // 3. else register with the join token and persist the result.
    let token = explicitToken;
    if (explicitToken) {
      console.warn(
        '[cezar-runner] --token / CEZAR_RUNNER_TOKEN is deprecated and will be removed in v0.3.0 — mint a join token in Settings → Runners and use --join-token / CEZAR_RUNNER_JOIN_TOKEN.',
      );
    }
    const stateDir = defaultStateDir();
    if (!token) {
      const saved = await readCredentials(stateDir, url);
      if (saved) {
        token = saved.token;
        console.log(`[cezar-runner] using persisted credentials (runner ${saved.runnerId})`);
      }
    }
    if (!token && joinToken) {
      token = await registerAndPersist({ url, joinToken, kind, backends, stateDir, values });
    }
    if (!token) {
      // Unreachable given the arg check above, but keeps the types honest.
      console.error('cezar-runner start: no usable credential.');
      process.exitCode = 1;
      return;
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

    const startDaemon = async (t: string) => {
      const daemon = new RunnerDaemon({
        url,
        token: t,
        backends,
        kind,
        concurrency: values.concurrency ? Number(values.concurrency) : undefined,
        pollIntervalSec: values['poll-interval'] ? Number(values['poll-interval']) : undefined,
        githubInheritHost: inheritHostGithub,
        githubInstallationId,
        // A persisted credential can go stale (runner revoked in Settings →
        // Runners, DB reset). With a join token at hand we can recover: wipe
        // the stale credential, re-register, and hand the daemon the fresh
        // token to restart with. Without one, exit loudly (previous behavior).
        onAuthError:
          !explicitToken && joinToken
            ? async () => {
                console.warn(
                  '[cezar-runner] runner token rejected — re-registering with the join token',
                );
                await clearCredentials(stateDir);
                return registerAndPersist({ url, joinToken, kind, backends, stateDir, values });
              }
            : undefined,
      });
      return daemon.start();
    };
    await startDaemon(token);
    return;
  }

  console.error(`cezar-runner: unknown command '${sub}'\n`);
  console.log(USAGE);
  process.exitCode = 1;
}

/** Registers via the join token, persists the credential, returns the runner token. */
async function registerAndPersist(opts: {
  url: string;
  joinToken: string;
  kind: RunnerDaemonConfig['kind'];
  backends: string[];
  stateDir: string;
  values: { name?: string };
}): Promise<string> {
  const name = opts.values.name || process.env.CEZAR_RUNNER_NAME || os.hostname();
  const res = await registerWithJoinToken({
    url: opts.url,
    joinToken: opts.joinToken,
    request: {
      name,
      kind: opts.kind,
      backends: opts.backends as ('anthropic-api' | 'claude-cli' | 'codex-cli')[],
    },
  });
  await writeCredentials(opts.stateDir, {
    url: opts.url,
    runnerId: res.runnerId,
    token: res.token,
    registeredAt: new Date().toISOString(),
  });
  console.log(
    `[cezar-runner] registered as "${name}" (owner @${res.ownerLogin})${
      res.reRegistered ? ' — re-keyed the existing runner of that name' : ''
    }`,
  );
  return res.token;
}

main().catch((err) => {
  console.error('[cezar-runner] fatal:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
