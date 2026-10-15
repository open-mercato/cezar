import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PreflightError, type InstallContext, type InstallStep, type StepArtifact } from '../types.ts';
import { owned, StepAborted, verifyCommand } from '../steps.ts';

/**
 * Shared machinery for the macOS platforms (`macosx-ngrok`,
 * `macosx-cloudflare-tunnel`, `macosx-tailscale`, `macosx-external-proxy`,
 * `macosx-caddy`): launchd agent
 * rendering + verified bootstrap/removal, the cezar cockpit agent itself
 * (every macOS strategy runs the same `ai.cezar.cockpit` agent), the Darwin
 * preflight, and a small HTTP probe for identity steps.
 */

/** Escape a value for inclusion in plist XML text. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const launchAgentPath = (label: string): string =>
  join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);

/**
 * `launchctl bootstrap` + proof the agent actually loaded. A discarded
 * bootstrap exit code (malformed plist, spawn failure) used to record the
 * step `done` — install reported complete with nothing running.
 */
export async function bootstrapVerified(
  ctx: InstallContext,
  uid: number,
  label: string,
  path: string,
  what: string,
): Promise<void> {
  const code = await ctx.runner.interactive('launchctl', ['bootstrap', `gui/${uid}`, path]);
  const loaded = (await ctx.runner.capture('launchctl', ['print', `gui/${uid}/${label}`])).code === 0;
  if (code !== 0 || !loaded) {
    throw new StepAborted(
      `launchctl could not load ${what} (bootstrap exit ${code}) — inspect it with: launchctl print gui/${uid}/${label}`,
    );
  }
}

export interface LaunchdAgentSpec {
  label: string;
  /** ProgramArguments — first entry is the absolute binary. */
  argv: string[];
  /** EnvironmentVariables — the secret channel: values here ride in the 0600
   *  plist but NOT in the process argv, where `ps` would expose them. */
  env?: Record<string, string>;
  workingDirectory?: string;
  /**
   * StandardOutPath / StandardErrorPath. launchd discards a job's output by
   * default, which makes a front that fails to start (a bad certificate, a
   * port already taken) invisible — name a file and the reason is on disk.
   */
  stdoutPath?: string;
  stderrPath?: string;
}

/** Render a launchd agent plist with RunAtLoad + KeepAlive. */
export function launchdAgentPlist(spec: LaunchdAgentSpec): string {
  // Escape every arg — a password/domain with `&`, `<`, `>` would otherwise
  // produce invalid plist XML and launchctl would silently fail to load it.
  const argXml = spec.argv.map((a) => `      <string>${escapeXml(a)}</string>`).join('\n');
  const envEntries = Object.entries(spec.env ?? {})
    .map(([k, v]) => `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Managed by cezar server-install — do not edit by hand. -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${spec.label}</string>
    <key>ProgramArguments</key>
    <array>
${argXml}
    </array>
${spec.workingDirectory ? `    <key>WorkingDirectory</key>\n    <string>${escapeXml(spec.workingDirectory)}</string>\n` : ''}${
    spec.stdoutPath ? `    <key>StandardOutPath</key>\n    <string>${escapeXml(spec.stdoutPath)}</string>\n` : ''
  }${spec.stderrPath ? `    <key>StandardErrorPath</key>\n    <string>${escapeXml(spec.stderrPath)}</string>\n` : ''}${
    envEntries ? `    <key>EnvironmentVariables</key>\n    <dict>\n${envEntries}\n    </dict>\n` : ''
  }    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
  </dict>
</plist>
`;
}

/**
 * Write a launchd agent plist (0600 — agents may embed credentials) and
 * bootstrap it, verified. Returns the plist path. Dry-run prints and stops.
 */
export async function installLaunchdAgent(ctx: InstallContext, label: string, content: string, what: string): Promise<string> {
  const path = launchAgentPath(label);
  if (ctx.dryRun) {
    ctx.ui.info(`DRY RUN — would write ${path} and launchctl bootstrap it.`);
    return path;
  }
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  // 0600: unlike the Linux htpasswd (a hash, 0640 root:www-data), a macOS agent
  // plist embeds PLAINTEXT credentials (basic-auth, tunnel token). `mode` only
  // applies on create, so chmod too for re-installs over an existing 0644 plist.
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  const uid = process.getuid ? process.getuid() : 0;
  // Bootout any prior instance so re-installs don't collide.
  await ctx.runner.capture('launchctl', ['bootout', `gui/${uid}/${label}`]);
  // Use the modern launchctl API — the legacy `launchctl load` returns
  // error 5 (EIO) on recent macOS versions.
  await bootstrapVerified(ctx, uid, label, path, what);
  return path;
}

/** Bootout + remove a launchd agent. Works from the static label/path so
 *  uninstall still reverses a step whose recorded `created` is null. */
export async function removeLaunchdAgent(ctx: InstallContext, label: string): Promise<void> {
  if (ctx.dryRun) {
    ctx.ui.info(`DRY RUN — would launchctl bootout and remove the ${label} agent.`);
    return;
  }
  const uid = process.getuid ? process.getuid() : 0;
  await ctx.runner.capture('launchctl', ['bootout', `gui/${uid}/${label}`]);
  rmSync(launchAgentPath(label), { force: true });
}

/**
 * Restart a running agent (server-deploy). Throws `StepAborted` when
 * `launchctl kickstart` exits non-zero, and when it exits 0 but launchd still
 * reports the same PID — a redeploy that restarted nothing must not read as done.
 */
export async function kickstartAgent(ctx: InstallContext, label: string, what: string): Promise<void> {
  if (ctx.dryRun) {
    ctx.ui.info(`DRY RUN — would restart ${what}.`);
    return;
  }
  const uid = process.getuid ? process.getuid() : 0;
  const previousPid = await launchdPid(ctx, uid, label);
  const code = await ctx.runner.interactive('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]);
  if (code !== 0) {
    throw new StepAborted(
      `launchctl could not restart ${what} (kickstart exit ${code}) — inspect it with: launchctl print gui/${uid}/${label}`,
    );
  }
  // A kickstart that exits 0 without replacing the process is a redeploy that changed nothing.
  const currentPid = await launchdPid(ctx, uid, label);
  if (previousPid && currentPid && previousPid === currentPid) {
    throw new StepAborted(
      `${what} did not actually restart (PID stayed ${currentPid}) — inspect it with: launchctl print gui/${uid}/${label}`,
    );
  }
}

/** The PID launchd currently associates with an agent, when it has one. */
async function launchdPid(ctx: InstallContext, uid: number, label: string): Promise<string | undefined> {
  const result = await ctx.runner.capture('launchctl', ['print', `gui/${uid}/${label}`]);
  if (result.code !== 0) return undefined;
  return /^\s*pid\s*=\s*(\d+)\s*$/m.exec(result.stdout)?.[1];
}

/** Every macOS strategy requires Darwin; say so politely on anything else. */
export async function darwinPreflight(ctx: InstallContext, platformId: string): Promise<void> {
  if (ctx.dryRun) {
    ctx.ui.info('DRY RUN — skipping OS preflight.');
    return;
  }
  if (!(await ctx.runner.capture('uname', ['-s'])).stdout.includes('Darwin')) {
    throw new PreflightError(`${platformId} requires macOS. On a Linux VPS use --platform ubuntu-vps.`);
  }
}

/**
 * Poll an HTTP endpoint until it answers with the expected status (identity
 * steps: the tunnel/agent needs a moment after launchctl bootstrap). The
 * matcher sees the `%{http_code}` in stdout ("000" when nothing answered).
 * The inter-attempt sleep goes through the runner so unit tests stay
 * timer-free.
 */
export async function probeHttp(
  ctx: InstallContext,
  url: string,
  matcher: (r: { code: number; stdout: string; stderr: string }) => boolean,
  attempts = 5,
  opts: {
    /** Extra curl flags, e.g. `-k` for a private CA or `--resolve` to pin a
     *  public hostname at this machine's own listener. */
    extraArgs?: string[];
    /** Fed to curl's stdin — the `-K -` channel for credentials, which keeps
     *  them out of the `ps`-readable argv. */
    input?: string;
  } = {},
): Promise<boolean> {
  if (ctx.dryRun) return false;
  const args = ['-s', '-o', '/dev/null', '-w', '%{http_code}', ...(opts.extraArgs ?? []), url];
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await ctx.runner.capture('sh', ['-c', 'sleep 1.5']);
    // `verifyCommand` has no stdin channel, so a credential probe goes through
    // the runner directly (same dry-run guard, applied above).
    const r = opts.input != null
      ? await ctx.runner.capture('curl', args, { input: opts.input })
      : await ctx.runner.capture('curl', args);
    if (matcher(r)) return true;
  }
  return false;
}

/* ── the cezar cockpit agent (shared by every macOS strategy) ─────────── */

export const CEZAR_PLIST_LABEL = 'ai.cezar.cockpit';
const OFFICIAL_CLI_PKG = 'cezar-cli';
export const cezarPlistPath = (): string => launchAgentPath(CEZAR_PLIST_LABEL);

/** Resolve the argv array for the cezar launchd agent, mirroring how the CLI was launched. */
export async function resolveCezarArgv(ctx: InstallContext): Promise<string[]> {
  const node = process.execPath;
  const pkgRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const entry = join(pkgRoot, 'dist', 'index.js');
  const npxPath = join(dirname(node), 'npx');

  if (/[/\\]_npx[/\\]/.test(pkgRoot)) return [npxPath, '--yes', OFFICIAL_CLI_PKG];
  if (ctx.dryRun || existsSync(entry)) return [node, entry];

  const out = (await ctx.runner.capture('bash', ['-lc', `command -v ${OFFICIAL_CLI_PKG} || command -v cezar`])).stdout.trim();
  const globalBin = out.split('\n').map((s) => s.trim()).filter(Boolean).pop();
  if (globalBin) return [node, globalBin];

  // No runnable cezar → installing a KeepAlive agent would make launchd
  // respawn-throttle a permanently failing job across reboots. Fail the step.
  throw new StepAborted(
    `could not locate a runnable cezar (${entry} missing, no global ${OFFICIAL_CLI_PKG}) — ` +
      `install it (npm i -g ${OFFICIAL_CLI_PKG}) or build the checkout, then re-run with --reconfigure autostart`,
  );
}

/**
 * launchd agent that keeps the cezar cockpit running on the given port.
 * Loopback stays the flag-less default; an external-proxy install binds an
 * interface its proxy can actually reach (`--bind-host`, same as the systemd
 * unit on ubuntu-vps).
 */
export function cezarLaunchdPlist(
  repoRoot: string,
  port: number,
  argv: string[],
  opts: {
    /** Interface to bind instead of loopback (an external-proxy install). */
    bindHost?: string;
    /** This install's identity, exported as `CEZ_INSTANCE_ID` so the identity step can tell
     *  this cockpit from another one occupying the port. */
    instanceId?: string;
  } = {},
): string {
  const { bindHost, instanceId } = opts;
  // Give the agent the operator's PATH so cezar can spawn claude/gh/codex.
  const pathDirs = [dirname(process.execPath), ...(process.env.PATH ?? '').split(':'), '/usr/local/bin', '/usr/bin', '/bin']
    .filter((d, i, a) => d && d !== '.' && a.indexOf(d) === i);
  const bind = bindHost?.trim() && bindHost.trim() !== '127.0.0.1' ? ['--bind-host', bindHost.trim()] : [];
  return launchdAgentPlist({
    label: CEZAR_PLIST_LABEL,
    argv: [...argv, 'serve', '--no-open', '--port', String(port), ...bind],
    workingDirectory: repoRoot,
    env: { CEZ_REMOTE: '1', ...(instanceId ? { CEZ_INSTANCE_ID: instanceId } : {}), PATH: pathDirs.join(':') },
  });
}

/** The cezar cockpit service step — identical across every macOS strategy. */
export const cezarAutostartStep: InstallStep = {
  id: 'autostart',
  title: 'Run cezar as a service (launchd — starts now + on boot)',
  async check(ctx) {
    if (ctx.dryRun) return false;
    return verifyCommand(ctx, 'test', ['-f', cezarPlistPath()]);
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    const argv = await resolveCezarArgv(ctx);
    const path = await installLaunchdAgent(
      ctx,
      CEZAR_PLIST_LABEL,
      cezarLaunchdPlist(ctx.repoRoot, ctx.state.primaryPort, argv, {
        bindHost: ctx.state.bindHost,
        instanceId: ctx.state.instanceId,
      }),
      'the cezar cockpit agent',
    );
    return { artifacts: [owned('launchd', { name: CEZAR_PLIST_LABEL, path })] };
  },
  async undo(ctx) {
    await removeLaunchdAgent(ctx, CEZAR_PLIST_LABEL);
  },
};
