import { CANCEL, type InstallContext, type InstallStep, type PlatformStrategy, type StepArtifact } from '../types.ts';
import { brewInstallTool, brewRemoveHint, depCheckStep, HOSTNAME_RE, owned, shared, StepCancelled, verifyCommand } from '../steps.ts';
import {
  CEZAR_PLIST_LABEL,
  cezarAutostartStep,
  darwinPreflight,
  installLaunchdAgent,
  kickstartAgent,
  launchAgentPath,
  launchdAgentPlist,
  probeHttp,
  removeLaunchdAgent,
} from './macosx-shared.ts';

/**
 * The `macosx-cloudflare-tunnel` strategy: cezar runs locally on a Mac and a
 * Cloudflare Tunnel (`cloudflared`) is the public front, in place of
 * nginx+certbot. Cloudflare terminates TLS at the edge; IDENTITY is a
 * Cloudflare Access application the operator attaches to the tunnel's public
 * hostname — cloudflared itself has no auth knob, so the install states that
 * requirement loudly instead of pretending a tunnel alone is enough.
 *
 * The tunnel is token-managed: the token (created in the Zero Trust dashboard)
 * rides in the agent plist's EnvironmentVariables — visible in the 0600 plist,
 * but NOT in the process argv where `ps` would expose it. Public-hostname →
 * `http://localhost:<port>` routing is configured dashboard-side (the token
 * flow carries no local config file).
 */

const PLIST_LABEL = 'ai.cezar.cloudflared';
/** cloudflared's local metrics endpoint — `/ready` is the "tunnel is connected" probe. */
const METRICS_ADDR = '127.0.0.1:20241';

/** launchd agent that keeps the token-managed tunnel up. */
export function cloudflaredPlist(token: string, cloudflaredBin = '/opt/homebrew/bin/cloudflared'): string {
  return launchdAgentPlist({
    label: PLIST_LABEL,
    argv: [cloudflaredBin, 'tunnel', '--no-autoupdate', '--metrics', METRICS_ADDR, 'run'],
    env: { TUNNEL_TOKEN: token },
  });
}

const ACCESS_NOTE = [
  'Cloudflare Tunnel carries NO authentication of its own, and cezar has no built-in auth.',
  'Protect the public hostname with a Cloudflare Access application (Zero Trust → Access →',
  'Applications → self-hosted), or anyone who learns the URL can run agents on this Mac.',
].join('\n');

const cloudflaredStep: InstallStep = {
  id: 'cloudflared',
  title: 'Cloudflare Tunnel (cloudflared + tunnel token)',
  async check(ctx) {
    if (ctx.dryRun) return false;
    return verifyCommand(ctx, 'test', ['-f', launchAgentPath(PLIST_LABEL)]);
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    // 1) cloudflared present?
    const present = await verifyCommand(ctx, 'cloudflared', ['--version']);
    if (!present) {
      if (ctx.dryRun) ctx.ui.info('DRY RUN — would run: brew install cloudflared');
      else await ctx.runner.interactive('brew', ['install', 'cloudflared']);
    }

    // 2) tunnel token (a secret — never stored in server.json; it lives in the
    //    0600 agent plist's environment, out of `ps`-visible argv)
    const token = await ctx.ui.password({
      message: 'Paste the tunnel token (Zero Trust → Networks → Tunnels → your tunnel → Configure → Install)',
      validate: (v) => (v.trim() ? undefined : 'a tunnel token is required'),
    });
    if (token === CANCEL) throw new StepCancelled();

    // 3) public hostname (configured dashboard-side; recorded for display only)
    const hostInput = await ctx.ui.text({
      message: 'Public hostname routed to the cockpit in the Cloudflare dashboard (leave blank if not set yet)',
      placeholder: 'cezar.example.com',
      validate: (v) => (!v.trim() || HOSTNAME_RE.test(v.trim()) ? undefined : 'enter a bare hostname (no scheme), e.g. cezar.example.com'),
    });
    if (hostInput === CANCEL) throw new StepCancelled();
    const hostname = typeof hostInput === 'string' && hostInput.trim() ? hostInput.trim() : undefined;

    ctx.ui.note(
      `In the Zero Trust dashboard, route the tunnel's public hostname to http://localhost:${ctx.state.primaryPort} ` +
        `(Networks → Tunnels → your tunnel → Public Hostname).`,
      'cloudflared',
    );

    // 4) launchd agent
    const cloudflaredBin = ctx.dryRun
      ? '/opt/homebrew/bin/cloudflared'
      : (await ctx.runner.capture('bash', ['-lc', 'command -v cloudflared'])).stdout.trim() || '/opt/homebrew/bin/cloudflared';
    const path = await installLaunchdAgent(
      ctx,
      PLIST_LABEL,
      cloudflaredPlist(String(token), cloudflaredBin),
      'the cloudflared tunnel agent',
    );

    if (hostname) {
      ctx.state.publicUrl = `https://${hostname}`;
      ctx.state.ephemeral = false;
    } else {
      // A token-managed tunnel has a stable hostname once configured, but the
      // installer never sees it when the operator hasn't set it up yet.
      ctx.state.ephemeral = true;
    }
    ctx.ui.warn(ACCESS_NOTE);

    const artifacts: StepArtifact[] = [owned('launchd', { name: PLIST_LABEL, path })];
    if (!present) artifacts.push(shared('package', { name: 'cloudflared', removeHint: 'brew uninstall cloudflared' }));
    return { artifacts };
  },
  async undo(ctx, created) {
    // Static label/path (see the ngrok step's undo) — the plist holds the token.
    await removeLaunchdAgent(ctx, PLIST_LABEL);
    const pkgs = (created?.artifacts ?? []).filter((a) => a.kind === 'shared');
    if (pkgs.length > 0) {
      ctx.ui.note(
        pkgs.map((a) => a.removeHint ?? a.name ?? '').filter(Boolean).join('\n'),
        'Installed for cezar but possibly used elsewhere — remove manually if unwanted',
      );
    }
  },
};

const identityStep: InstallStep = {
  id: 'identity',
  title: 'Identity check (tunnel connected + Access reminder)',
  async check() {
    return false;
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would confirm the cloudflared tunnel reports ready.');
      return { artifacts: [] };
    }
    // cloudflared needs a moment after bootstrap to dial the edge; /ready on
    // the metrics endpoint answers 200 only once the tunnel is connected.
    const ready = await probeHttp(ctx, `http://${METRICS_ADDR}/ready`, (r) => r.stdout.trim() === '200');
    if (ready) ctx.ui.success(`Cloudflare Tunnel is connected${ctx.state.publicUrl ? ` — ${ctx.state.publicUrl}` : ''}.`);
    else
      ctx.ui.warn(
        `The tunnel did not report ready on ${METRICS_ADDR} yet — it retries on its own.\n` +
          `Check: launchctl print gui/${process.getuid ? process.getuid() : 0}/${PLIST_LABEL}, ` +
          `or \`log show --predicate 'process == "cloudflared"' --last 5m\`.`,
      );
    ctx.ui.warn(ACCESS_NOTE);
    return { artifacts: [] };
  },
  async undo() {
    // nothing created
  },
};

export const macosxCloudflareTunnel: PlatformStrategy = {
  id: 'macosx-cloudflare-tunnel',
  label: 'macOS + Cloudflare Tunnel',
  async preflight(ctx: InstallContext) {
    await darwinPreflight(ctx, 'macosx-cloudflare-tunnel');
  },
  steps(): InstallStep[] {
    return [
      depCheckStep({ installTool: brewInstallTool, removeHint: brewRemoveHint }),
      cezarAutostartStep,
      cloudflaredStep,
      identityStep,
    ];
  },
  async redeploy(ctx: InstallContext) {
    // Restart both the cezar cockpit and the tunnel, then re-verify.
    ctx.ui.info('Redeploying — restarting the cezar cockpit.');
    await kickstartAgent(ctx, CEZAR_PLIST_LABEL, 'the cezar cockpit agent');
    ctx.ui.info('Redeploying — restarting the cloudflared tunnel.');
    await kickstartAgent(ctx, PLIST_LABEL, 'the cloudflared tunnel agent');
    await identityStep.run(ctx);
  },
};
