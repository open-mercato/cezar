import { CANCEL, type InstallContext, type InstallStep, type PlatformStrategy, type StepArtifact } from '../types.ts';
import { brewInstallTool, brewRemoveHint, depCheckStep, owned, shared, StepAborted, StepCancelled, verifyCommand } from '../steps.ts';
import { CEZAR_PLIST_LABEL, cezarAutostartStep, darwinPreflight, kickstartAgent, probeHttp } from './macosx-shared.ts';

/**
 * The `macosx-tailscale` strategy: cezar runs locally on a Mac and Tailscale is
 * the front, in place of nginx+certbot. Unlike the other macOS strategies this
 * one installs NO second launchd agent — `tailscale serve` persists its mapping
 * in tailscaled's own state, so the front comes back with the daemon on boot.
 * What the step "creates" is that mapping, and undo turns off exactly the one
 * it created (never `serve reset`, which would also wipe mappings the operator
 * set up outside cezar).
 *
 * Three modes, and the difference is the whole security story:
 *  - `serve` (default) — reachable from the tailnet on THIS node's own
 *    `*.ts.net` name. Identity is tailnet membership: a device has to be logged
 *    into your tailnet to reach the cockpit at all. Zero admin setup.
 *  - `service` — a Tailscale Service: the cockpit gets its own stable
 *    `<name>.<tailnet>.ts.net` identity with its own virtual IP, independent of
 *    which Mac hosts it, and access is a grant in your ACL policy targeting
 *    `svc:<name>` rather than the whole node. The better answer when the
 *    cockpit should keep its address across machines, or when only some of the
 *    tailnet should reach it. Costs prerequisites (see `SERVICE_NOTE`).
 *  - `funnel` — the node's hostname published to the open internet. Funnel
 *    carries NO authentication and cezar has none built in, so this mode warns
 *    exactly as loudly as a bare Cloudflare Tunnel does.
 */

/** The mapping cezar owns on the node: HTTPS on the standard port. */
const SERVE_PORT = 443;

/** Tailscale Services landed in 1.86 — the version the `service` mode needs. */
const SERVICES_MIN_VERSION = '1.86.0';

export type TailscaleMode = 'serve' | 'service' | 'funnel';

/** Where the cockpit listens — loopback unless `--bind-host` named another interface. */
function bindHost(ctx: InstallContext): string {
  return ctx.state.bindHost?.trim() || '127.0.0.1';
}

/** The local target `tailscale serve` proxies to. */
export function serveTarget(ctx: InstallContext): string {
  return `http://${bindHost(ctx)}:${ctx.state.primaryPort}`;
}

/** `cezar`, `svc:cezar`, ` Cezar ` → `svc:cezar`. */
export function normalizeServiceName(input: string): string {
  return `svc:${input.trim().replace(/^svc:/i, '').trim().toLowerCase()}`;
}

/**
 * Argv that publishes the cockpit.
 *  - serve/funnel: `--bg`, because those keep a foreground proxy otherwise.
 *  - service: the `--service` form is persistent config by definition (and
 *    advertises the endpoint), so `--bg` has nothing to background.
 */
export function serveArgs(mode: TailscaleMode, target: string, service?: string): string[] {
  if (mode === 'service') {
    if (!service) throw new StepAborted('internal: service mode needs a service name');
    return ['serve', `--service=${service}`, `--https=${SERVE_PORT}`, target];
  }
  return [mode, '--bg', `--https=${SERVE_PORT}`, target];
}

/** Argv that withdraws it again. Tailscale requires the original flags to say `off`. */
export function offArgs(mode: TailscaleMode, service?: string): string[] {
  if (mode === 'service') return ['serve', `--service=${service ?? ''}`, `--https=${SERVE_PORT}`, 'off'];
  return [mode, `--https=${SERVE_PORT}`, 'off'];
}

const FUNNEL_NOTE = [
  'Tailscale Funnel publishes this cockpit to the OPEN INTERNET, and it carries no',
  'authentication of its own — neither does cezar. Anyone who learns the URL can run',
  'agents on this Mac. Prefer tailnet-only unless you have put an authenticating',
  'front of your own in between.',
].join('\n');

const SERVE_NOTE = [
  'Reachable from your tailnet only — every device that can reach it is already',
  'authenticated to your Tailscale account. It rides this node\'s own name, so the',
  'whole tailnet can reach it and the URL changes if the cockpit moves to another',
  'Mac. Re-run with `--reconfigure tailscale` and pick "Tailscale Service" for a',
  'stable name plus per-service ACL grants.',
].join('\n');

const SERVICE_NOTE = [
  'Access is whatever your ACL policy grants for this service — nothing else on the',
  'tailnet reaches it, e.g.:',
  '    { "src": ["group:ops"], "dst": ["svc:cezar"], "ip": ["443"] }',
  'The name is the service\'s, not the Mac\'s, so moving the cockpit to another host',
  'keeps the URL.',
].join('\n');

const SERVICE_PREREQS = [
  `Tailscale Services need a little setup first (Tailscale ${SERVICES_MIN_VERSION}+):`,
  '  1. Define the service in the admin console (Services → Add service).',
  '  2. This Mac must have a TAG-based identity — a device logged in as a user',
  '     cannot host a service:  tailscale up --advertise-tags=tag:cezar',
  '  3. Grant access in your ACL policy with `dst: ["svc:<name>"]`.',
  '  4. Approve this host for the service (unless auto-approval is configured).',
].join('\n');

/**
 * The App Store / standalone Tailscale app ships its CLI inside the bundle
 * rather than on PATH; Homebrew's `tailscale` puts it in the usual bin dir.
 * Resolve whichever this Mac actually has.
 */
const APP_BUNDLE_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export async function resolveTailscaleBin(ctx: InstallContext): Promise<string> {
  if (ctx.dryRun) return 'tailscale';
  const onPath = (await ctx.runner.capture('bash', ['-lc', 'command -v tailscale'])).stdout.trim();
  if (onPath) return onPath;
  if ((await ctx.runner.capture('test', ['-x', APP_BUNDLE_CLI])).code === 0) return APP_BUNDLE_CLI;
  return 'tailscale';
}

/** `tailscale status --json` → the node's stable `*.ts.net` name, if it has one. */
export function dnsNameFromStatus(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { Self?: { DNSName?: string } };
    // MagicDNS names come back fully qualified, with the trailing root dot.
    const name = parsed.Self?.DNSName?.replace(/\.$/, '').trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

/**
 * `tailscale status --json` → the tailnet's MagicDNS suffix (`example.ts.net`),
 * which is what a Service's name is built on. `MagicDNSSuffix` is the direct
 * answer; falling back to the node name minus its first label keeps this
 * working against a status payload that omits it.
 */
export function magicDnsSuffix(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { MagicDNSSuffix?: string; Self?: { DNSName?: string } };
    const direct = parsed.MagicDNSSuffix?.replace(/^\.|\.$/g, '').trim();
    if (direct) return direct;
    const self = parsed.Self?.DNSName?.replace(/\.$/, '').trim();
    const rest = self?.split('.').slice(1).join('.');
    return rest || undefined;
  } catch {
    return undefined;
  }
}

/** `tailscale status --json` → is the daemon actually up and logged in? */
export function backendRunning(stdout: string): boolean {
  try {
    return (JSON.parse(stdout) as { BackendState?: string }).BackendState === 'Running';
  } catch {
    return false;
  }
}

const tailscaleStep: InstallStep = {
  id: 'tailscale',
  title: 'Tailscale front (tailnet, Tailscale Service, or public Funnel)',
  async check(ctx) {
    if (ctx.dryRun) return false;
    // Satisfied when a mapping to our port already exists on this node — one
    // `serve status` covers plain serve, funnel and services alike.
    const bin = await resolveTailscaleBin(ctx);
    const target = serveTarget(ctx);
    return verifyCommand(ctx, bin, ['serve', 'status'], (r) => r.code === 0 && r.stdout.includes(target));
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    // 1) tailscale present?
    const present = await verifyCommand(ctx, 'tailscale', ['version']);
    if (!present) {
      if (ctx.dryRun) ctx.ui.info('DRY RUN — would run: brew install tailscale');
      else {
        await ctx.runner.interactive('brew', ['install', 'tailscale']);
        // Homebrew ships the daemon but does not start it; the Mac App Store
        // app runs its own. Say so rather than failing later with an opaque
        // "is tailscaled running?".
        ctx.ui.note(
          'Homebrew installs the CLI and daemon but does not start the daemon:\n' +
            '  sudo brew services start tailscale\n' +
            'Using the Mac App Store app instead? Launch Tailscale.app once and it runs its own daemon.',
          'tailscale',
        );
      }
    }
    const bin = await resolveTailscaleBin(ctx);

    // 2) logged into a tailnet? `tailscale up` opens a browser to authenticate.
    if (!ctx.dryRun) {
      const status = await ctx.runner.capture(bin, ['status', '--json']);
      if (!backendRunning(status.stdout)) {
        ctx.ui.info('This Mac is not logged into a tailnet yet — running `tailscale up` (it opens a browser).');
        await ctx.runner.interactive(bin, ['up']);
        if (!backendRunning((await ctx.runner.capture(bin, ['status', '--json'])).stdout)) {
          throw new StepAborted(
            'Tailscale is still not running/logged in — finish `tailscale up` (and make sure the daemon is started: ' +
              '`sudo brew services start tailscale`, or launch Tailscale.app), then re-run with --reconfigure tailscale',
          );
        }
      }
    }

    // 3) how should it be reachable? The default is the one that needs no admin setup.
    const picked = await ctx.ui.select<TailscaleMode>({
      message: 'How should the cockpit be reachable?',
      options: [
        { value: 'serve', label: 'Tailnet, on this Mac\'s name', hint: 'tailscale serve — tailnet membership IS the login, no admin setup' },
        { value: 'service', label: 'Tailnet, as a Tailscale Service', hint: 'stable name + per-service ACL grants; needs a tagged host' },
        { value: 'funnel', label: 'Public internet (Funnel)', hint: 'anyone with the URL — Funnel has NO authentication' },
      ],
      initialValue: 'serve',
    });
    if (picked === CANCEL) throw new StepCancelled();
    const mode: TailscaleMode = picked === 'funnel' || picked === 'service' ? picked : 'serve';
    if (mode === 'funnel') ctx.ui.warn(FUNNEL_NOTE);

    // 3b) a Service needs a name, and prerequisites the operator owns.
    let service: string | undefined;
    if (mode === 'service') {
      ctx.ui.note(SERVICE_PREREQS, 'Tailscale Services');
      const nameInput = await ctx.ui.text({
        message: 'Service name (as defined in the admin console)',
        placeholder: 'cezar',
        initialValue: 'cezar',
        // The `svc:` prefix is added for them; the rest is a DNS label.
        validate: (v) =>
          /^(svc:)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(v.trim())
            ? undefined
            : 'use a DNS label, e.g. cezar (a leading svc: is optional)',
      });
      if (nameInput === CANCEL) throw new StepCancelled();
      service = normalizeServiceName(String(nameInput || 'cezar'));
    }

    // 4) publish it. tailscaled persists the mapping, so it survives reboots
    //    without a launchd agent of cezar's own.
    const target = serveTarget(ctx);
    const args = serveArgs(mode, target, service);
    if (ctx.dryRun) {
      ctx.ui.info(`DRY RUN — would run: tailscale ${args.join(' ')}`);
    } else {
      const code = await ctx.runner.interactive(bin, args);
      if (code !== 0) {
        throw new StepAborted(
          `\`tailscale ${args.join(' ')}\` failed (exit ${code}).\n` +
            'Usual causes:\n' +
            '  • HTTPS certificates are not enabled for the tailnet (admin console → DNS → HTTPS Certificates)\n' +
            (mode === 'funnel' ? '  • the node lacks the `funnel` attribute in your ACL policy (admin console → Access Controls)\n' : '') +
            (mode === 'service'
              ? `  • Tailscale older than ${SERVICES_MIN_VERSION} (\`tailscale version\`), the service is not defined in the\n` +
                '    admin console, or this Mac is logged in as a USER — a service host must be tagged:\n' +
                '      tailscale up --advertise-tags=tag:cezar\n'
              : '  • an older Tailscale without `--bg` — upgrade, or map it by hand:\n' +
                `      tailscale ${mode} https:${SERVE_PORT} / ${target}\n`),
        );
      }
    }

    // 5) the public identity — stable in every mode, unlike an ngrok free tunnel.
    const statusJson = ctx.dryRun ? '' : (await ctx.runner.capture(bin, ['status', '--json'])).stdout;
    const suffix = magicDnsSuffix(statusJson);
    const host =
      mode === 'service'
        ? suffix && service
          ? `${service.replace(/^svc:/, '')}.${suffix}`
          : undefined
        : dnsNameFromStatus(statusJson);

    ctx.state.tailscaleMode = mode;
    // Every mode lands on a stable MagicDNS name — nothing here rotates on restart.
    ctx.state.ephemeral = false;
    if (host) {
      ctx.state.publicUrl = `https://${host}`;
      const where = mode === 'funnel' ? 'public internet' : mode === 'service' ? 'tailnet, as a service' : 'tailnet only';
      ctx.ui.success(`Cockpit published at https://${host} (${where}).`);
    } else if (!ctx.dryRun) {
      ctx.ui.warn('Could not read the MagicDNS name from `tailscale status --json` — check `tailscale status`.');
    }
    if (mode === 'service') {
      ctx.ui.note(
        'A newly advertised service host needs approval in the admin console (Services → your service → Hosts) ' +
          'unless auto-approval is configured.',
        'Tailscale Services',
      );
    }

    const artifacts: StepArtifact[] = [
      owned('tailscale-serve', { name: service ?? `https:${SERVE_PORT}`, scope: mode }),
    ];
    if (!present) artifacts.push(shared('package', { name: 'tailscale', removeHint: 'brew uninstall tailscale' }));
    return { artifacts };
  },
  async undo(ctx, created) {
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would withdraw the tailscale serve/service/funnel mapping for the cockpit.');
      return;
    }
    const bin = await resolveTailscaleBin(ctx);
    // Withdraw only the mapping cezar created. `serve reset` would be simpler
    // and would also wipe mappings the operator added themselves, so it is not
    // what uninstall does. A step satisfied via check() records `created: null`
    // — fall back to turning off every mode we could have set on our port.
    const record = (created?.artifacts ?? []).find((a) => a.type === 'tailscale-serve');
    const scope = record?.scope;
    const mode: TailscaleMode | undefined = scope === 'serve' || scope === 'service' || scope === 'funnel' ? scope : undefined;
    const service = record?.name?.startsWith('svc:') ? record.name : undefined;

    if (mode === 'service' && service) {
      // Drain first so in-flight connections close gracefully, then remove the
      // endpoint — `off` needs the same flags the mapping was created with.
      await ctx.runner.capture(bin, ['serve', 'drain', service]);
      await ctx.runner.capture(bin, offArgs('service', service));
    } else if (mode) {
      await ctx.runner.capture(bin, offArgs(mode));
    } else {
      for (const m of ['funnel', 'serve'] as const) await ctx.runner.capture(bin, offArgs(m));
      ctx.ui.note(
        'No mapping was recorded for this step. If the cockpit was published as a Tailscale Service, ' +
          'withdraw it with: tailscale serve clear svc:<name>',
        'tailscale',
      );
    }

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
  title: 'Identity check (tailnet membership / ACL grants, or the Funnel warning)',
  async check() {
    return false; // always re-verify; it creates nothing
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    const stored = ctx.state.tailscaleMode;
    const mode: TailscaleMode = stored === 'funnel' || stored === 'service' ? stored : 'serve';
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would confirm the cockpit answers through Tailscale and print the identity note.');
      return { artifacts: [] };
    }

    // The cockpit itself first: tailscale can only proxy to something that is up.
    const target = serveTarget(ctx);
    if (!(await probeHttp(ctx, `${target}/api/v1/health`, (r) => r.stdout.trim() !== '000'))) {
      ctx.ui.error(
        `cezar is not answering on ${target}.\n\n` +
          `Diagnostics on this Mac:\n` +
          `  • launchctl print gui/${process.getuid ? process.getuid() : 0}/${CEZAR_PLIST_LABEL}\n` +
          `  • lsof -nP -iTCP:${ctx.state.primaryPort} -sTCP:LISTEN`,
      );
      throw new StepAborted('cockpit verification failed — see the diagnostics above');
    }

    // Then the front. The node answers for its own name (and for a service it
    // hosts), so this request exercises the real path end to end.
    const url = ctx.state.publicUrl;
    if (url && (await probeHttp(ctx, `${url}/api/v1/health`, (r) => r.stdout.trim() !== '000'))) {
      ctx.ui.success(`${url} is answering through Tailscale (${mode}).`);
    } else if (url) {
      const bin = await resolveTailscaleBin(ctx);
      ctx.ui.warn(
        `${url} did not answer yet — Tailscale may still be provisioning the certificate (the first request can take ~30s)` +
          (mode === 'service' ? ', and a new service host stays dark until it is approved in the admin console' : '') +
          `.\nCheck: ${bin} serve status`,
      );
    }

    if (mode === 'funnel') ctx.ui.warn(FUNNEL_NOTE);
    else ctx.ui.note(mode === 'service' ? SERVICE_NOTE : SERVE_NOTE, 'Identity');
    return { artifacts: [] };
  },
  async undo() {
    // nothing created
  },
};

export const macosxTailscale: PlatformStrategy = {
  id: 'macosx-tailscale',
  label: 'macOS + Tailscale',
  async preflight(ctx: InstallContext) {
    await darwinPreflight(ctx, 'macosx-tailscale');
  },
  steps(): InstallStep[] {
    return [
      depCheckStep({ installTool: brewInstallTool, removeHint: brewRemoveHint }),
      cezarAutostartStep,
      tailscaleStep,
      identityStep,
    ];
  },
  async redeploy(ctx: InstallContext) {
    // Only the cockpit needs restarting — the mapping lives in tailscaled's
    // state and keeps pointing at the same local port.
    ctx.ui.info('Redeploying — restarting the cezar cockpit.');
    await kickstartAgent(ctx, CEZAR_PLIST_LABEL, 'the cezar cockpit agent');
    // A service host stops being advertised after a drain (and a deploy is
    // exactly when one was likely drained) — re-advertise before verifying.
    if (ctx.state.tailscaleMode === 'service' && !ctx.dryRun) {
      const service = (ctx.state.steps.tailscale?.created?.artifacts ?? []).find((a) => a.name?.startsWith('svc:'))?.name;
      if (service) {
        const bin = await resolveTailscaleBin(ctx);
        await ctx.runner.capture(bin, ['serve', 'advertise', service]);
      }
    }
    await identityStep.run(ctx); // throws StepAborted if the cockpit isn't answering
  },
};
