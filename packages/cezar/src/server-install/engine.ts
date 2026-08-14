import { loadWorkspaceConfig } from '../workspace/config.ts';
import { acquireLock, deleteServerState, isResolved, loadServerState, saveServerState } from './state.ts';
import { StepAborted, StepCancelled, StepSkipped, defaultRunner } from './steps.ts';
import { createAutoUi, createClackUi } from './ui.ts';
import {
  CANCEL,
  PreflightError,
  type InstallContext,
  type PlatformStrategy,
  type Runner,
  type ServerState,
  type StepOutcome,
  type Ui,
} from './types.ts';

/**
 * The engine — pure control flow over a strategy's ordered steps. It never
 * knows what a step *does*, only `check`/`run`/`undo`. `runInstall` resumes
 * from `~/.cezar/server.json` (skips resolved steps unless `--reconfigure`
 * names them); `runUninstall` walks completed steps in reverse. Both hold the
 * single-writer lock for their whole run.
 */

export interface RunOptions {
  dryRun: boolean;
  assumeYes: boolean;
  reconfigure: ReadonlySet<string>;
  /** `--reinstall`: force every step to re-run, ignoring recorded/present state. */
  reinstall?: boolean;
  repoRoot: string;
  /** ISO timestamp from the caller (Date.now is guarded in some contexts). */
  now: string;
  ui?: Ui;
  runner?: Runner;
  /**
   * Instance id (slug) to act on. Omit / `default` for the original
   * single-cockpit host (legacy `~/.cezar/server.json`); a domain-derived slug
   * targets a named instance under `~/.cezar/server-instances/`.
   */
  instance?: string;
  /** Public domain for this instance — recorded up front so instance selection
   * and the SSL step share one source of truth. */
  domain?: string;
  /** Loopback port for this instance. For a NEW named instance the caller
   * passes an auto-picked free port; a resume keeps the recorded one. */
  port?: number;
  /** `--external-proxy`: an existing reverse proxy fronts cezar, so the
   * platform installs no nginx/SSL of its own. */
  externalProxy?: boolean;
  /** `--bind-host`: interface the cockpit binds so that proxy can reach it. */
  bindHost?: string;
}

export type RunStatus = 'complete' | 'cancelled' | 'failed';
export interface RunResult {
  status: RunStatus;
  state: ServerState;
}

/**
 * Record a step outcome WITHOUT losing the artifact ledger: `server.json`
 * exists so uninstall can reverse what was created, so a re-run that is
 * cancelled/skipped/failed must keep the artifacts recorded by the previous
 * successful run. Only a successful `run()` (which re-creates or supersedes
 * them) may replace `created`.
 */
function recordOutcome(state: ServerState, id: string, status: StepOutcome['status']): void {
  state.steps[id] = { status, created: state.steps[id]?.created ?? null };
}

/** An outcome uninstall must reverse: completed, failed mid-run, or anything
 * that still has recorded artifacts (e.g. a done step later downgraded). */
function needsUndo(outcome: StepOutcome | undefined): outcome is StepOutcome {
  if (!outcome) return false;
  if (outcome.status === 'done' || outcome.status === 'failed') return true;
  return (outcome.created?.artifacts.length ?? 0) > 0;
}

/**
 * A `CEZ_DRY_RUN` preview persists a full ledger with no real side effects
 * (the packaged e2e round-trip depends on that). Two invariants keep previews
 * from destroying real state:
 *
 *  1. A dry-run NEVER persists over a REAL record — the preview mutates its
 *     in-memory copy only, so a preview on an installed host can't stamp
 *     `dryRun: true` onto (or delete steps from) the genuine ledger.
 *  2. A REAL run never resumes from a preview record — steps would all report
 *     "already done" while nothing is installed. It self-heals by resetting.
 */
function reconcileDryRun(state: ServerState, opts: RunOptions, ui: Ui): { persist: boolean } {
  const realRecord = !state.dryRun && (state.installed || Object.keys(state.steps).length > 0);
  if (opts.dryRun && realRecord) {
    ui.info('DRY RUN over a real install record — previewing only, nothing will be saved to server.json.');
    return { persist: false };
  }
  if (!opts.dryRun && state.dryRun) {
    ui.info('The recorded state came from a CEZ_DRY_RUN preview — starting from a clean slate.');
    state.steps = {};
    state.installed = false;
    state.platform = undefined;
    state.publicUrl = undefined;
    state.ephemeral = undefined;
  }
  if (opts.dryRun) state.dryRun = true;
  else delete state.dryRun;
  return { persist: true };
}

function buildContext(state: ServerState, opts: RunOptions): InstallContext {
  // Real `--yes` runs fail closed on prompts they cannot answer; dry-run
  // previews stay lenient so they can walk every step.
  const ui =
    opts.ui ??
    (opts.dryRun || opts.assumeYes
      ? createAutoUi({}, (m) => console.log(m), { strictValidate: !opts.dryRun })
      : createClackUi());
  const instance = opts.instance ?? 'default';
  const ctx: InstallContext = {
    state,
    ui,
    instance,
    runner: opts.runner ?? defaultRunner,
    save: async () => saveServerState(state, instance),
    dryRun: opts.dryRun,
    assumeYes: opts.assumeYes,
    reconfigure: opts.reconfigure,
    repoRoot: opts.repoRoot,
    now: opts.now,
    prefs: {},
  };
  const { persist } = reconcileDryRun(state, opts, ui);
  if (!persist) ctx.save = async () => {};
  return ctx;
}

export async function runInstall(strategy: PlatformStrategy, opts: RunOptions): Promise<RunResult> {
  const release = acquireLock(opts.instance);
  try {
    const state = loadServerState(opts.instance);
    // buildContext reconciles dry-run records first, so a preview of platform A
    // never blocks a real install of platform B (the reset clears `platform`).
    const ctx = buildContext(state, opts);
    if (state.platform && state.platform !== strategy.id) {
      throw new PreflightError(
        `this host already has a ${state.platform} install recorded — run \`server-uninstall\` first to switch platforms`,
      );
    }
    state.platform = strategy.id;
    // Record instance identity so the file is self-describing and later
    // uninstall/deploy runs (and `server-instances/` listings) agree on it.
    state.instance = opts.instance ?? state.instance ?? 'default';
    if (opts.domain) state.domain = opts.domain;
    // Proxy mode + bind host are recorded before `steps(ctx)` runs, because the
    // platform selects its step list from them (external proxy ⇒ no nginx/SSL).
    if (opts.externalProxy !== undefined) state.externalProxy = opts.externalProxy;
    if (opts.bindHost) state.bindHost = opts.bindHost;
    // A caller-supplied port wins (a new named instance auto-picks a free one);
    // otherwise keep whatever the resumed record already carries.
    if (opts.port) state.primaryPort = opts.port;
    state.createdAt ??= opts.now;
    state.updatedAt = opts.now;

    await strategy.preflight(ctx); // throws PreflightError to refuse politely

    const steps = strategy.steps(ctx);
    const knownIds = new Set(steps.map((s) => s.id));
    const unknownIds = [...opts.reconfigure].filter((id) => !knownIds.has(id));
    if (unknownIds.length > 0) {
      throw new PreflightError(
        `unknown --reconfigure step id(s): ${unknownIds.join(', ')} — ` +
          `valid ids for ${strategy.id}: ${[...knownIds].join(', ')}`,
      );
    }
    if (opts.reinstall) {
      ctx.ui.info(`Reinstalling ${strategy.label} — every step will re-run.`);
    } else {
      const resolvedCount = steps.filter((s) => isResolved(state.steps[s.id])).length;
      if (resolvedCount > 0) {
        ctx.ui.info(`Resuming ${strategy.label} — ${resolvedCount}/${steps.length} steps already done.`);
      }
    }

    for (const step of steps) {
      // `--reinstall` forces every step; `--reconfigure` forces the named ones.
      const forced = opts.reinstall === true || opts.reconfigure.has(step.id);
      if (!forced && isResolved(state.steps[step.id])) {
        ctx.ui.info(`= ${step.title} (already done)`);
        continue;
      }
      // Already satisfied on the box (fresh install, nothing recorded yet)?
      if (!forced && (await step.check(ctx))) {
        state.steps[step.id] = { status: 'done', created: state.steps[step.id]?.created ?? null };
        await ctx.save();
        ctx.ui.info(`= ${step.title} (already present)`);
        continue;
      }

      if (step.optional) {
        // `--yes` = accept safe defaults, and the safe default for an optional
        // step (SSL against a real domain, autostart) is to SKIP it — never run
        // it non-interactively against placeholder input.
        if (ctx.assumeYes) {
          recordOutcome(state, step.id, 'skipped');
          await ctx.save();
          ctx.ui.info(`— ${step.title} (skipped: --yes)`);
          continue;
        }
        const proceed = await ctx.ui.confirm({ message: `Set up ${step.title}?`, initialValue: true });
        if (proceed === CANCEL) {
          recordOutcome(state, step.id, 'pending');
          await ctx.save();
          ctx.ui.warn(`Cancelled at "${step.title}". Progress saved — re-run to resume.`);
          return { status: 'cancelled', state };
        }
        if (proceed !== true) {
          recordOutcome(state, step.id, 'skipped');
          await ctx.save();
          ctx.ui.info(`— ${step.title} (skipped)`);
          continue;
        }
      }

      try {
        const created = await step.run(ctx);
        state.steps[step.id] = { status: 'done', created };
        state.updatedAt = opts.now;
        await ctx.save();
      } catch (err) {
        if (err instanceof StepSkipped) {
          recordOutcome(state, step.id, 'skipped');
          await ctx.save();
          ctx.ui.info(`— ${step.title} (skipped: ${err.message})`);
          continue;
        }
        if (err instanceof StepCancelled) {
          recordOutcome(state, step.id, 'pending');
          await ctx.save();
          ctx.ui.warn(`Cancelled at "${step.title}". Progress saved — re-run to resume.`);
          return { status: 'cancelled', state };
        }
        if (err instanceof StepAborted) {
          recordOutcome(state, step.id, 'failed');
          await ctx.save();
          ctx.ui.error(`Stopped at "${step.title}": ${err.message}`);
          return { status: 'failed', state };
        }
        recordOutcome(state, step.id, 'failed');
        await ctx.save();
        throw err;
      }
    }

    const requiredAllDone = steps
      .filter((s) => !s.optional)
      .every((s) => state.steps[s.id]?.status === 'done');
    state.installed = requiredAllDone;
    state.updatedAt = opts.now;
    await ctx.save();
    return { status: 'complete', state };
  } finally {
    release();
  }
}

export async function runUninstall(strategy: PlatformStrategy, opts: RunOptions): Promise<RunResult> {
  const release = acquireLock(opts.instance);
  try {
    const state = loadServerState(opts.instance);
    const ctx = buildContext(state, opts);
    // Same guard as install/deploy: undoing with the wrong strategy would skip
    // the real artifacts and (before this guard existed) destroy their ledger.
    if (state.platform && state.platform !== strategy.id) {
      throw new PreflightError(
        `this host has a ${state.platform} install recorded — run \`server-uninstall --platform ${state.platform}\``,
      );
    }

    const registeredProjects = (await loadWorkspaceConfig()).projects.length;
    if (registeredProjects > 0) {
      ctx.ui.warn(
        `${registeredProjects} ${registeredProjects === 1 ? 'project is' : 'projects are'} registered in ~/.cezar/config.json.`,
      );
      const proceed = await ctx.ui.confirm({
        message: 'Removing this server will make them unavailable. Continue?',
        initialValue: false,
      });
      if (proceed !== true) return { status: 'cancelled', state };
    }

    // Reverse order: undo the last-created first. `failed` outcomes are undone
    // too — the step may have created artifacts before failing, and every undo
    // is written to work from constants with a null/partial `created`.
    const steps = [...strategy.steps(ctx)].reverse();
    for (const step of steps) {
      const outcome = state.steps[step.id];
      if (!needsUndo(outcome)) continue;
      try {
        await step.undo(ctx, outcome.created ?? null);
        delete state.steps[step.id];
        state.updatedAt = opts.now;
        await ctx.save();
      } catch (err) {
        if (err instanceof StepCancelled) {
          ctx.ui.warn(`Cancelled during uninstall at "${step.title}". Re-run to continue.`);
          return { status: 'cancelled', state };
        }
        ctx.ui.error(`Failed to reverse "${step.title}": ${err instanceof Error ? err.message : String(err)}`);
        return { status: 'failed', state };
      }
    }

    // Drop entries that never had a system effect; anything left was recorded
    // by a step id this binary doesn't know (a newer cezar) and was NOT
    // reversed — keep its ledger and say so instead of silently erasing it.
    for (const id of Object.keys(state.steps)) {
      if (!needsUndo(state.steps[id])) delete state.steps[id];
    }
    const leftover = Object.keys(state.steps);
    state.installed = false;
    state.updatedAt = opts.now;
    if (leftover.length > 0) {
      ctx.ui.warn(
        `Not reversed (recorded by a different cezar version): ${leftover.join(', ')}. ` +
          'Their record is kept — re-run server-uninstall with the cezar version that installed them.',
      );
      await ctx.save();
      return { status: 'failed', state };
    }
    // A completed uninstall leaves the record empty so the host can be
    // re-installed with any platform (the install guard keys off `platform`,
    // so it must be cleared here too).
    state.platform = undefined;
    state.publicUrl = undefined;
    state.ephemeral = undefined;
    state.domain = undefined;
    await ctx.save();
    // A named instance is fully gone now — drop its (empty) record so it no
    // longer reserves a port or shows up as an install. The default record is
    // kept, matching the legacy single-host behavior.
    if (ctx.instance !== 'default') deleteServerState(ctx.instance);
    return { status: 'complete', state };
  } finally {
    release();
  }
}

/**
 * Reload the running cockpit to pick up a new cezar version — the standardized
 * `server-deploy` flow. Delegates to the platform's `redeploy` (restart service
 * + re-verify); holds the single-writer lock for the whole run.
 */
export async function runDeploy(strategy: PlatformStrategy, opts: RunOptions): Promise<RunResult> {
  const release = acquireLock(opts.instance);
  try {
    const state = loadServerState(opts.instance);
    const ctx = buildContext(state, opts);
    if (state.platform && state.platform !== strategy.id) {
      throw new PreflightError(
        `this host has a ${state.platform} install recorded — deploy it with --platform ${state.platform}`,
      );
    }
    if (!state.installed) {
      ctx.ui.warn(
        `no completed ${strategy.label} install is recorded on this host — run \`server-install --platform ${strategy.id}\` first.`,
      );
      return { status: 'failed', state };
    }
    if (!strategy.redeploy) {
      ctx.ui.warn(`${strategy.label} does not support server-deploy.`);
      return { status: 'failed', state };
    }
    try {
      await strategy.redeploy(ctx);
    } catch (err) {
      if (err instanceof StepAborted || err instanceof StepCancelled) {
        ctx.ui.error(`Deploy did not complete: ${err.message}`);
        return { status: 'failed', state };
      }
      throw err;
    }
    state.updatedAt = opts.now;
    await ctx.save();
    return { status: 'complete', state };
  } finally {
    release();
  }
}
