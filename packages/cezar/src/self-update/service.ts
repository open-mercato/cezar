/**
 * The self-update service behind `/api/v1/workspace/self-update` and `cezar update`. Owns the
 * registry cache, the release-channel setting, the managed-layout view and the ONE install job
 * a process runs at a time. Applying an update = install (npm) → activate (`current` link) →
 * restart (re-exec, or exit for a supervisor to relaunch — see `restart.ts`).
 */

import type { SelfUpdateDevelopment, SelfUpdateJob, SelfUpdateStatus, UpdateChannel } from '@open-mercato/cezar-contract';

import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { installFromLocal, installFromRegistry } from './installer.ts';
import { buildCheckout, discoverCheckouts } from './checkouts.ts';
import { activate, detectInstallKind, findInstalled, linkCheckout, listInstalled, packageRootOf, type InstallKind } from './layout.ts';
import { CEZAR_REPO, fetchOpenPulls, OpenPullsCache, type OpenPulls } from './pulls.ts';
import { distTagFor, RegistryCache, type PackageDocument } from './registry.ts';
import { classifyVersion, isNewer } from './semver.ts';

const LOG_CAP = 200;

export interface SelfUpdateDeps {
  pkgName: string;
  version: string;
  /** The running entry file (`process.argv[1]`). */
  entry: string;
  /** Exit-or-reexec policy; the service only decides WHEN. */
  restart: () => void;
  /** Runs in flight across the workspace, for the dialog's warning. */
  activeRuns?: () => number;
  /** Hosted mode trims the absolute entry path off the wire (#431). */
  trimPaths?: () => boolean;
  supervised?: boolean;
  /** Report only: `capability()` answers false whatever the install kind, so `apply()` can
   *  never install or activate. For a service that has no way to restart the process. */
  readOnly?: boolean;
  env?: NodeJS.ProcessEnv;
  registry?: RegistryCache;
  /** cezar's open pull requests, for the development channel. Defaults to GitHub. */
  pulls?: () => Promise<OpenPulls>;
  /** Builds an unbuilt or stale checkout before it is linked. Defaults to npm in the worktree. */
  buildCheckout?: typeof buildCheckout;
}

export class SelfUpdateBusyError extends Error {
  constructor() {
    super('an update is already running');
  }
}

export class SelfUpdateService {
  readonly installKind: InstallKind;
  private readonly registry: RegistryCache;
  private readonly env: NodeJS.ProcessEnv;
  private job: SelfUpdateJob | null = null;
  private readonly pulls: OpenPullsCache;

  constructor(private readonly deps: SelfUpdateDeps) {
    this.env = deps.env ?? process.env;
    this.installKind = detectInstallKind(deps.entry, this.env);
    this.registry = deps.registry ?? new RegistryCache(deps.pkgName);
    this.pulls = new OpenPullsCache(deps.pulls ?? (() => fetchOpenPulls(CEZAR_REPO, { env: this.env })));
  }

  /** The configured channel: workspace config wins, then `CEZ_UPDATE_CHANNEL`, then stable. */
  async channel(): Promise<UpdateChannel> {
    const config = await loadWorkspaceConfig();
    if (config.updateChannel) return config.updateChannel;
    const seed = this.env.CEZ_UPDATE_CHANNEL;
    return seed === 'nightly' || seed === 'development' ? seed : 'stable';
  }

  async setChannel(channel: UpdateChannel): Promise<void> {
    await mergeWriteWorkspaceConfig((config) => {
      config.updateChannel = channel;
    });
  }

  /** The channel's newest version when it is newer than the running one — what health's
   *  `latestVersion` reports and the version chip pulses for. */
  async updateAvailable(refresh = false): Promise<string | null> {
    const doc = refresh ? await this.registry.refresh() : await this.registry.get();
    const channel = await this.channel();
    // Development runs whatever was picked by hand; nothing is ever "newer" than a worktree.
    if (!doc || channel === 'development') return null;
    const target = doc.distTags[distTagFor(channel)];
    return target && isNewer(target, this.deps.version) ? target : null;
  }

  /** Read the status without waiting on the network: the cached document answers, and a stale
   *  or missing one is refreshed behind the response. `refresh` forces a registry round trip. */
  async status(opts: { refresh?: boolean } = {}): Promise<SelfUpdateStatus> {
    let doc: PackageDocument | null;
    if (opts.refresh) doc = await this.registry.refresh();
    else {
      doc = this.registry.current();
      void this.registry.get().catch(() => {});
    }
    const channel = await this.channel();
    const installed = listInstalled(this.env);
    const installedIds = new Set(installed.map((entry) => entry.id));
    const stable = doc?.distTags.latest ?? null;
    const nightly = doc?.distTags.nightly ?? null;
    const target = channel === 'stable' ? stable : channel === 'nightly' ? nightly : null;
    const { canSelfUpdate, reason } = this.capability();
    const trim = this.deps.trimPaths?.() ?? false;
    return {
      version: this.deps.version,
      installKind: this.installKind,
      entry: trim ? this.deps.entry.split(/[\\/]/).pop() ?? '' : this.deps.entry,
      canSelfUpdate,
      ...(reason ? { reason } : {}),
      channel,
      restartMode: this.deps.supervised ? 'supervisor' : 'reexec',
      latest: { stable, nightly },
      updateAvailable: target && isNewer(target, this.deps.version) ? target : null,
      checkedAt: doc?.fetchedAt ?? null,
      installed: installed.map((entry) => ({
        id: entry.id,
        version: entry.version,
        source: entry.source,
        installedAt: entry.installedAt,
        active: entry.active,
        ...(entry.branch ? { branch: entry.branch } : {}),
        ...(entry.checkout && !trim ? { checkout: entry.checkout } : {}),
      })),
      // Previews (`-pr123.`, `-develop.`) are noise in a picker meant for stable ↔ nightly
      // moves; the PoC lists stable releases and nightlies only.
      available: (doc?.versions ?? [])
        .filter((entry) => entry.channel !== 'preview')
        .slice(0, 60)
        .map((entry) => ({
          version: entry.version,
          channel: entry.channel,
          publishedAt: entry.publishedAt,
          installed: installedIds.has(entry.version),
        })),
      job: this.job,
      activeRuns: this.deps.activeRuns?.() ?? 0,
    };
  }

  /**
   * What the development channel picks from: cezar's own worktrees and the open pull requests
   * with a published preview build. Worktrees only on a local cockpit — linking a checkout runs
   * whatever is in it, a local-machine gesture a hosted cockpit neither offers nor accepts (see
   * `linkDiscovered`), and never worth a git call there.
   */
  async development(opts: { refresh?: boolean } = {}): Promise<SelfUpdateDevelopment> {
    const trim = this.deps.trimPaths?.() ?? false;
    const [checkouts, pulls, doc] = await Promise.all([
      trim ? Promise.resolve([]) : discoverCheckouts(this.env).catch(() => []),
      this.pulls.get(opts.refresh),
      opts.refresh ? this.registry.refresh() : this.registry.get(),
    ]);
    const installedIds = new Set(listInstalled(this.env).map((entry) => entry.id));
    const publishedAt = (version: string) => doc?.versions.find((entry) => entry.version === version)?.publishedAt ?? null;
    const prByBranch = new Map(pulls.items.map((pull) => [pull.branch, pull.number]));
    return {
      checkouts: checkouts.map((checkout) => ({
        id: checkout.id,
        branch: checkout.branch,
        version: checkout.version,
        worktree: checkout.worktree,
        built: checkout.built,
        linked: checkout.linked,
        commit: checkout.commit,
        builtAt: checkout.builtAt,
        stale: checkout.stale,
        task: checkout.task,
        pr: prByBranch.get(checkout.branch) ?? null,
      })),
      pulls: {
        available: pulls.available,
        ...(pulls.reason ? { reason: pulls.reason } : {}),
        repo: CEZAR_REPO,
        items: pulls.items.map((pull) => {
          const version = doc?.distTags[`pr-${pull.number}`] ?? null;
          return {
            ...pull,
            version,
            publishedAt: version ? publishedAt(version) : null,
            installed: version ? installedIds.has(version) : false,
          };
        }),
      },
    };
  }

  /**
   * Whether a HOSTED cockpit may apply `target` — hosted updates are forward-only, and "forward"
   * has to mean forward in TIME, not merely in semver order. cezar's nightlies are versioned
   * `<next-version>-nightly.<date>.<run>`, so every `0.13.0-nightly.*` outranks every later
   * `0.12.x` patch: a semver-only rule would let a hosted cockpit on 0.12.1 install a 0.13.0
   * nightly cut months earlier and restart into code that predates the guards this rule exists
   * to protect. The registry's publish dates are the honest signal; when it cannot supply them
   * (offline, or a version it does not list) the residual risk is a prerelease outranking a
   * release, so that shape is refused outright.
   *
   * Returns the refusal reason, or null when the target may be applied.
   */
  async forwardOnlyRefusal(target: string): Promise<string | null> {
    const running = this.deps.version;
    const suffix = 'apply it on the host itself (`cezar use <id>`)';
    if (!isNewer(target, running)) {
      return `a hosted cockpit can only update forward — ${target} is not newer than the running ${running}; ${suffix}`;
    }
    const doc = this.registry.current() ?? (await this.registry.get());
    const publishedAt = (version: string) => doc?.versions.find((entry) => entry.version === version)?.publishedAt ?? null;
    const targetAt = publishedAt(target);
    const runningAt = publishedAt(running);
    if (targetAt && runningAt) {
      return targetAt >= runningAt
        ? null
        : `a hosted cockpit can only update forward — ${target} was published before the running ${running}; ${suffix}`;
    }
    if (classifyVersion(target) !== 'stable' && classifyVersion(running) === 'stable') {
      return `a hosted cockpit can only update forward — ${target} is a prerelease and the registry gave no publish date to check it against; ${suffix}`;
    }
    return null;
  }

  capability(): { canSelfUpdate: boolean; reason?: string } {
    if (this.deps.readOnly) return { canSelfUpdate: false, reason: 'This cezar was started without an updater.' };
    switch (this.installKind) {
      case 'managed':
        return { canSelfUpdate: true };
      case 'npx':
        return {
          canSelfUpdate: false,
          reason: 'This cezar runs from the npx cache, which npx replaces on its own. Install it permanently to update from here.',
        };
      case 'global-npm':
        return {
          canSelfUpdate: false,
          reason: 'This cezar was installed with npm -g. Update it with npm, or install the managed layout to update from here.',
        };
      case 'checkout':
        return { canSelfUpdate: false, reason: 'This cezar runs from a git checkout — rebuild it instead of updating.' };
      default:
        return { canSelfUpdate: false, reason: 'cezar could not tell how it was installed.' };
    }
  }

  /**
   * Install `target` (a registry version, an already-installed id such as `0.11.1+local`, or the
   * id of a built cezar checkout `status()` lists — linked on the spot), activate it and restart.
   * Returns as soon as the job is started; progress is on `status()`.
   */
  apply(target: string): SelfUpdateJob {
    if (this.job?.status === 'running' || this.job?.status === 'restarting') throw new SelfUpdateBusyError();
    const { canSelfUpdate, reason } = this.capability();
    if (!canSelfUpdate) throw new Error(reason ?? 'self-update is not available for this install');
    const job: SelfUpdateJob = { status: 'running', target, startedAt: new Date().toISOString(), finishedAt: null, log: [] };
    this.job = job;
    const log = (line: string) => {
      job.log.push(line);
      if (job.log.length > LOG_CAP) job.log.splice(0, job.log.length - LOG_CAP);
    };
    void (async () => {
      try {
        const installed = findInstalled(target, this.env);
        // A linked checkout goes through discovery too: it may need a rebuild before it runs.
        const linked = !installed || installed.source === 'link' ? await this.linkDiscovered(target, log) : null;
        const id = linked ?? installed?.id ?? (await installFromRegistry(target, { onLog: log, env: this.env })).id;
        if (installed && !linked) log(`${id} is already installed`);
        activate(id, this.env);
        log(`activated ${id}`);
        job.status = 'restarting';
        job.finishedAt = new Date().toISOString();
        log('restarting…');
        // Let the status poll that observes `restarting` get its answer before the listener goes.
        setTimeout(() => this.deps.restart(), 750);
      } catch (error) {
        job.status = 'failed';
        job.finishedAt = new Date().toISOString();
        job.error = error instanceof Error ? error.message : String(error);
        log(`failed: ${job.error}`);
      }
    })();
    return job;
  }

  /** A checkout `status()` offers under `target`: build it when it is unbuilt or older than its
   *  last commit, link it and return its id. Null when no checkout answers to that id — the
   *  target is then an installed entry or a registry version. A hosted cockpit never builds or
   *  links here (`trimPaths`); at most it activates a link the host itself created, and only one
   *  `forwardOnlyRefusal` lets through. */
  private async linkDiscovered(target: string, log: (line: string) => void): Promise<string | null> {
    if (this.deps.trimPaths?.()) return null;
    const checkout = (await discoverCheckouts(this.env)).find((entry) => entry.id === target);
    if (!checkout) return null;
    if (!checkout.built || checkout.stale) {
      log(`${checkout.built ? 'rebuilding' : 'building'} ${checkout.branch} first`);
      await (this.deps.buildCheckout ?? buildCheckout)(checkout, log);
    }
    log(`linking ${checkout.packageRoot} (${checkout.branch})`);
    return linkCheckout(checkout.packageRoot, checkout.branch, this.env, checkout.id).id;
  }

  /** `cezar install` from a checkout or the npx cache: pack the running package into the managed
   *  layout and activate it. Headless — the CLI prints the log. */
  async installSelf(onLog: (line: string) => void): Promise<{ id: string; entry: string }> {
    const result = await installFromLocal(packageRootOf(this.deps.entry), { onLog, env: this.env });
    activate(result.id, this.env);
    return result;
  }
}
