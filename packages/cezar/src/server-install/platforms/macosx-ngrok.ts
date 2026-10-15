import { CANCEL, type InstallContext, type InstallStep, type PlatformStrategy, type StepArtifact } from '../types.ts';
import { brewInstallTool, brewRemoveHint, depCheckStep, HOSTNAME_RE, owned, shared, StepAborted, StepCancelled, verifyCommand } from '../steps.ts';
import {
  CEZAR_PLIST_LABEL,
  cezarAutostartStep,
  darwinPreflight,
  installLaunchdAgent,
  kickstartAgent,
  launchAgentPath,
  launchdAgentPlist,
  removeLaunchdAgent,
} from './macosx-shared.ts';

/**
 * The `macosx-ngrok` strategy: the app runs locally on a Mac and ngrok is the
 * public front, in place of nginx+certbot. ngrok's built-in `--basic-auth` is
 * the identity gate (the htpasswd equivalent), and a launchd agent is the
 * autostart (the systemd equivalent). Proves the engine seam with a genuinely
 * different platform — same engine, different steps.
 *
 * The launchd mechanics and the cezar cockpit agent live in
 * `macosx-shared.ts`, reused by every macOS strategy.
 */

const PLIST_LABEL = 'ai.cezar.ngrok';

// Re-exported: the cezar cockpit agent plist builder moved to macosx-shared
// (with an optional bindHost for the external-proxy strategy); existing
// consumers and tests import it from here.
export { cezarLaunchdPlist } from './macosx-shared.ts';

/** launchd agent that keeps an authenticated ngrok tunnel to the local cockpit up. */
export function launchdPlist(port: number, basicAuth: string, domain?: string, ngrokBin = '/opt/homebrew/bin/ngrok'): string {
  const args = ['http', String(port), '--basic-auth', basicAuth];
  if (domain) args.push('--domain', domain);
  return launchdAgentPlist({ label: PLIST_LABEL, argv: [ngrokBin, ...args] });
}

const ngrokStep: InstallStep = {
  id: 'ngrok',
  title: 'ngrok tunnel (authtoken + domain + basic-auth)',
  async check(ctx) {
    if (ctx.dryRun) return false;
    return verifyCommand(ctx, 'test', ['-f', launchAgentPath(PLIST_LABEL)]);
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    // 1) ngrok present?
    const present = await verifyCommand(ctx, 'ngrok', ['version']);
    if (!present) {
      if (ctx.dryRun) ctx.ui.info('DRY RUN — would run: brew install ngrok/ngrok/ngrok');
      else await ctx.runner.interactive('brew', ['install', 'ngrok/ngrok/ngrok']);
    }

    // 2) authtoken (a secret — never stored in server.json; it lives in ngrok's own config)
    const token = await ctx.ui.password({
      message: 'Paste your ngrok authtoken (dashboard.ngrok.com → Your Authtoken)',
      validate: (v) => (v.trim() ? undefined : 'authtoken is required'),
    });
    if (token === CANCEL) throw new StepCancelled();
    // The token expands INSIDE the child shell: argv carries only the literal
    // string `"$NGROK_AUTHTOKEN"`, so `ps` never sees the secret. It lands in
    // ngrok's own config (~/Library/Application Support/ngrok/ngrok.yml, 0600
    // by ngrok itself), never in server.json.
    if (!ctx.dryRun) {
      const code = await ctx.runner.interactive('bash', ['-c', 'ngrok config add-authtoken "$NGROK_AUTHTOKEN"'], {
        env: { NGROK_AUTHTOKEN: String(token) },
      });
      if (code !== 0) throw new StepAborted('ngrok rejected the authtoken (`ngrok config add-authtoken` failed) — check the token and re-run');
    }

    // 3) reserved domain (optional → ephemeral URL)
    const domainInput = await ctx.ui.text({
      message: 'Reserved ngrok domain (leave blank for an ephemeral URL that changes on restart)',
      placeholder: 'cezar.ngrok.app',
      // Bare hostname only — `https://…` here used to yield `--domain https://…`
      // in the plist and a `https://https://…` publicUrl.
      validate: (v) => (!v.trim() || HOSTNAME_RE.test(v.trim()) ? undefined : 'enter a bare hostname (no scheme), e.g. cezar.ngrok.app'),
    });
    if (domainInput === CANCEL) throw new StepCancelled();
    // Guard against `String(undefined)` → `"undefined"` — @clack/prompts can
    // return undefined when the user accepts without typing over the placeholder.
    const domain = typeof domainInput === 'string' && domainInput.trim() ? domainInput.trim() : undefined;

    // 4) basic-auth identity
    const user = await ctx.ui.text({
      message: 'Basic-auth username for the tunnel',
      placeholder: 'ops',
      validate: (v) => (v.trim() ? undefined : 'username is required'),
    });
    if (user === CANCEL) throw new StepCancelled();
    const password = await ctx.ui.password({
      message: `Basic-auth password for "${user}"`,
      validate: (v) => (v.length >= 6 ? undefined : 'use at least 6 characters'),
    });
    if (password === CANCEL) throw new StepCancelled();
    if (!ctx.dryRun && String(password).length < 6) {
      throw new StepAborted('a basic-auth password (≥6 chars) is required — run server-install without --yes to set one');
    }
    const basicAuth = `${String(user)}:${String(password)}`;

    // 5) launchd agent (the plist embeds the basic-auth creds, like htpasswd on Linux)
    // Resolve the real ngrok binary path so the plist works on both Apple
    // Silicon (/opt/homebrew/bin) and Intel (/usr/local/bin) Macs.
    const ngrokBin = ctx.dryRun
      ? '/opt/homebrew/bin/ngrok'
      : (await ctx.runner.capture('bash', ['-lc', 'command -v ngrok'])).stdout.trim() || '/opt/homebrew/bin/ngrok';
    const path = await installLaunchdAgent(
      ctx,
      PLIST_LABEL,
      launchdPlist(ctx.state.primaryPort, basicAuth, domain, ngrokBin),
      'the ngrok tunnel agent',
    );

    if (domain) {
      ctx.state.publicUrl = `https://${domain}`;
      ctx.state.ephemeral = false;
    } else {
      ctx.state.ephemeral = true;
      ctx.ui.note('No reserved domain — the tunnel URL is ephemeral and changes each restart. Find it at http://localhost:4040.', 'ngrok');
    }

    return {
      artifacts: [
        shared('ngrok-config', { name: 'authtoken', removeHint: 'ngrok config add-authtoken "" (or edit ~/Library/Application Support/ngrok/ngrok.yml)' }),
        owned('launchd', { name: PLIST_LABEL, path }),
      ],
    };
  },
  async undo(ctx, created) {
    // Work from the static label/path, not just the recorded artifact — a step
    // satisfied via check() records `created: null`, and the agent (whose plist
    // holds the basic-auth credentials) must still be removed.
    await removeLaunchdAgent(ctx, PLIST_LABEL);
    const cfg = (created?.artifacts ?? []).find((a) => a.type === 'ngrok-config');
    if (cfg) {
      ctx.ui.note(
        `The ngrok authtoken was left in ngrok's own config — remove it yourself if you want it gone:\n${cfg.removeHint ?? ''}`,
        'ngrok',
      );
    }
  },
};

export const macosxNgrokIdentityStep: InstallStep = {
  id: 'identity',
  title: 'Identity check (ngrok basic-auth active)',
  async check() {
    return false;
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would confirm the ngrok tunnel is up and basic-auth is enforced.');
      return { artifacts: [] };
    }
    // ngrok needs a moment after launchctl bootstrap to bind to :4040.
    // Retry a few times with a short delay before giving up.
    let up = false;
    for (let attempt = 0; attempt < 5 && !up; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
      up = await verifyCommand(ctx, 'curl', ['-s', 'http://localhost:4040/api/tunnels'], (r) => r.stdout.includes('public_url'));
    }
    if (!up) {
      ctx.ui.warn('Could not reach the ngrok local API (localhost:4040) — check the tunnel started.');
      return { artifacts: [] };
    }

    // Probe the local cockpit directly as well: ngrok proves the public edge,
    // while the health identity proves this launchd agent did not reach another
    // cezar process occupying the configured port.
    let identity: 'match' | 'mismatch' | 'inconclusive' = 'inconclusive';
    if (ctx.state.instanceId) {
      const response = await ctx.runner.capture('curl', [
        '-s', `http://127.0.0.1:${ctx.state.primaryPort}/api/v1/health`, '-w', '\n%{http_code}',
      ]);
      const lines = response.stdout.split('\n');
      const code = lines.pop()?.trim() ?? '000';
      if (/^[23]\d\d$/.test(code)) {
        try {
          const payload = JSON.parse(lines.join('\n')) as { instanceId?: unknown };
          if (typeof payload.instanceId === 'string') identity = payload.instanceId === ctx.state.instanceId ? 'match' : 'mismatch';
        } catch {
          // Older or non-cezar responders make identity inconclusive.
        }
      }
    }
    if (identity === 'mismatch') {
      throw new StepAborted(`the cockpit on 127.0.0.1:${ctx.state.primaryPort} is serving another install, not this one`);
    }
    if (identity === 'inconclusive') {
      ctx.ui.warn('ngrok is up, but the cockpit instance identity check could not run (older or invalid health payload).');
    } else {
      ctx.ui.success('ngrok tunnel is up (basic-auth enforced at the ngrok edge) and the cockpit identity matches.');
    }
    return { artifacts: [] };
  },
  async undo() {
    // nothing created
  },
};

export const macosxNgrok: PlatformStrategy = {
  id: 'macosx-ngrok',
  label: 'macOS + ngrok',
  async preflight(ctx: InstallContext) {
    await darwinPreflight(ctx, 'macosx-ngrok');
  },
  steps(): InstallStep[] {
    return [
      depCheckStep({ installTool: brewInstallTool, removeHint: brewRemoveHint }),
      cezarAutostartStep,
      ngrokStep,
      macosxNgrokIdentityStep,
    ];
  },
  async redeploy(ctx: InstallContext) {
    // Restart both the cezar cockpit and the ngrok tunnel, then re-verify.
    ctx.ui.info('Redeploying — restarting the cezar cockpit.');
    await kickstartAgent(ctx, CEZAR_PLIST_LABEL, 'the cezar cockpit agent');
    ctx.ui.info('Redeploying — restarting the ngrok tunnel.');
    await kickstartAgent(ctx, PLIST_LABEL, 'the ngrok tunnel agent');
    await macosxNgrokIdentityStep.run(ctx);
  },
};
