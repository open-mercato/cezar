import { type InstallContext, type InstallStep, type PlatformStrategy, type StepArtifact } from '../types.ts';
import { brewInstallTool, brewRemoveHint, depCheckStep, StepAborted } from '../steps.ts';
import {
  CEZAR_PLIST_LABEL,
  cezarAutostartStep,
  darwinPreflight,
  kickstartAgent,
  probeHttp,
} from './macosx-shared.ts';

/**
 * The `macosx-external-proxy` strategy: the Mac ALREADY has a public front the
 * operator owns (Caddy, nginx, a tunnel they manage themselves, Tailscale
 * Funnel, …) that terminates TLS and enforces auth. cezar installs NO proxy of
 * its own — just the launchd cockpit service — and that front routes to the
 * bound host:port. The macOS analogue of `ubuntu-vps --external-proxy` as a
 * first-class platform.
 *
 * cezar has no built-in authentication, so the identity step is where we say —
 * unmissably — that the front has to enforce it.
 */

/** The interface the cockpit listens on — loopback unless `--bind-host` named
 *  one the operator's proxy can reach. */
function bindHost(ctx: InstallContext): string {
  return ctx.state.bindHost?.trim() || '127.0.0.1';
}

const identityStep: InstallStep = {
  id: 'identity',
  title: 'Verify the cockpit is listening (your proxy provides TLS + auth)',
  async check() {
    return false; // always re-verify; it creates nothing
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    const port = ctx.state.primaryPort;
    const host = bindHost(ctx);
    const target = `http://${host}:${port}`;

    if (ctx.dryRun) {
      ctx.ui.info(`DRY RUN — would verify cezar answers on ${target} and print the proxy routing snippet.`);
      return { artifacts: [] };
    }

    // Any HTTP status (even 404) proves the process is up; "000" = nothing there.
    if (!(await probeHttp(ctx, `${target}/api/v1/health`, (r) => r.stdout.trim() !== '000'))) {
      ctx.ui.error(
        `cezar is not answering on ${target}.\n\n` +
          `Diagnostics on this Mac:\n` +
          `  • launchctl print gui/${process.getuid ? process.getuid() : 0}/${CEZAR_PLIST_LABEL}\n` +
          `  • lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
          (host === '127.0.0.1'
            ? ''
            : `  • is ${host} a real local interface? (ifconfig) — a proxy in a container or VM\n` +
              `    cannot dial this Mac's loopback\n`),
      );
      // Fail the run so `installed` stays false — "complete" must mean the
      // cockpit actually answers where the operator's proxy will look for it.
      throw new StepAborted('cockpit verification failed — see the diagnostics above');
    }

    ctx.ui.success(`Cockpit is up and listening on ${target}.`);
    ctx.ui.warn(
      `cezar has NO built-in authentication in this mode — your front MUST enforce it (and TLS). ` +
        `Anyone who can reach ${target} can run agents on this Mac.`,
    );
    ctx.ui.message(
      [
        `Point your existing front at ${target}. Examples:`,
        ``,
        `  Caddy (Caddyfile):`,
        `    cezar.example.com {`,
        `      basic_auth {`,
        `        USER <bcrypt hash>     # caddy hash-password`,
        `      }`,
        `      reverse_proxy ${host}:${port}`,
        `    }`,
        ``,
        `  nginx:`,
        `    location / {`,
        `      auth_basic "cezar";`,
        `      auth_basic_user_file /path/to/htpasswd;`,
        `      proxy_pass ${target};`,
        `      proxy_http_version 1.1;`,
        `      proxy_set_header Host $host;`,
        `      # cezar streams SSE — never buffer it, or the cockpit goes mute:`,
        `      proxy_buffering off;`,
        `      proxy_read_timeout 3600s;`,
        `    }`,
        ``,
        `Keep ${host}:${port} off the public internet (firewall / bind) — the front`,
        `should be the only thing that can reach it.`,
      ].join('\n'),
    );
    return { artifacts: [] };
  },
  async undo() {
    // nothing created
  },
};

export const macosxExternalProxy: PlatformStrategy = {
  id: 'macosx-external-proxy',
  label: 'macOS + external proxy',
  async preflight(ctx: InstallContext) {
    await darwinPreflight(ctx, 'macosx-external-proxy');
    // This strategy IS external-proxy mode — record it so a flag-less resume /
    // deploy keeps the same meaning it has on ubuntu-vps.
    ctx.state.externalProxy = true;
  },
  steps(): InstallStep[] {
    return [
      depCheckStep({ installTool: brewInstallTool, removeHint: brewRemoveHint }),
      cezarAutostartStep,
      identityStep,
    ];
  },
  async redeploy(ctx: InstallContext) {
    ctx.ui.info('Redeploying — restarting the cezar cockpit.');
    await kickstartAgent(ctx, CEZAR_PLIST_LABEL, 'the cezar cockpit agent');
    await identityStep.run(ctx); // throws StepAborted if the cockpit isn't answering
  },
};
