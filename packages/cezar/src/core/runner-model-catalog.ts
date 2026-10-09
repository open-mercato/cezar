import type { RunnerId } from './agent-runner.ts';

export interface ModelOption {
  id: string;
  label: string;
  description: string;
}

export type ModelCatalogSource = 'live' | 'cache' | 'unavailable';

export interface RunnerModelCatalogResult {
  runner: RunnerId;
  models: ModelOption[];
  source: ModelCatalogSource;
  stale: boolean;
  reason?: string;
}

export interface RunnerModelCatalogAdapter {
  discover(): Promise<ModelOption[]>;
}

export interface RunnerModelCatalogOptions {
  adapters: Partial<Record<RunnerId, RunnerModelCatalogAdapter>>;
  now?: () => number;
  ttlMs?: number;
  usableTtlMs?: number;
}

interface CachedCatalog {
  models: ModelOption[];
  /** The next time a discovery may be requested (freshness or failure cooldown). */
  refreshAfter: number;
  expiresAt: number;
  failureReason?: string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_USABLE_TTL_MS = 60 * 60 * 1_000;

/** Host-level, in-memory model discovery cache shared by every workspace. */
export class RunnerModelCatalog {
  readonly #adapters: Partial<Record<RunnerId, RunnerModelCatalogAdapter>>;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #usableTtlMs: number;
  readonly #cache = new Map<RunnerId, CachedCatalog>();
  readonly #inFlight = new Map<RunnerId, Promise<RunnerModelCatalogResult>>();

  constructor(options: RunnerModelCatalogOptions) {
    this.#adapters = options.adapters;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#usableTtlMs = options.usableTtlMs ?? DEFAULT_USABLE_TTL_MS;
  }

  get(runner: RunnerId): Promise<RunnerModelCatalogResult> {
    const cached = this.#cache.get(runner);
    const now = this.#now();
    if (cached && now < cached.refreshAfter) {
      if (cached.failureReason) {
        return Promise.resolve({
          runner,
          models: cached.models,
          source: cached.models.length > 0 ? 'cache' : 'unavailable',
          stale: cached.models.length > 0,
          reason: cached.failureReason,
        });
      }
      return Promise.resolve({ runner, models: cached.models, source: 'cache', stale: false });
    }

    // Keep discovery latency off the picker path while a healthy answer is still usable.
    if (cached && !cached.failureReason && cached.models.length > 0 && now < cached.expiresAt) {
      this.#refreshInBackground(runner, cached);
      return Promise.resolve({ runner, models: cached.models, source: 'cache', stale: false });
    }

    const pending = this.#inFlight.get(runner);
    if (pending) return pending;

    const refresh = this.#refresh(runner, cached).finally(() => {
      this.#inFlight.delete(runner);
    });
    this.#inFlight.set(runner, refresh);
    return refresh;
  }

  #refreshInBackground(runner: RunnerId, cached: CachedCatalog): void {
    if (this.#inFlight.has(runner)) return;
    const refresh = this.#refresh(runner, cached).finally(() => {
      this.#inFlight.delete(runner);
    });
    this.#inFlight.set(runner, refresh);
    // #refresh handles adapter failures, but keep this detached path safe if an
    // unexpected implementation error escapes it.
    void refresh.catch(() => undefined);
  }

  async #refresh(
    runner: RunnerId,
    cached: CachedCatalog | undefined,
  ): Promise<RunnerModelCatalogResult> {
    try {
      const adapter = this.#adapters[runner];
      if (!adapter) throw new Error('adapter unavailable');
      const models = await adapter.discover();
      const now = this.#now();
      const value = {
        models: [...models],
        refreshAfter: now + this.#ttlMs,
        expiresAt: now + this.#usableTtlMs,
      };
      this.#cache.set(runner, value);
      return { runner, models: value.models, source: 'live', stale: false };
    } catch {
      const reason = unavailableReason(runner);
      if (cached) {
        this.#cache.set(runner, {
          models: cached.models,
          refreshAfter: this.#now() + this.#ttlMs,
          expiresAt: cached.expiresAt,
          failureReason: reason,
        });
        return { runner, models: cached.models, source: 'cache', stale: true, reason };
      }
      const now = this.#now();
      this.#cache.set(runner, {
        models: [],
        refreshAfter: now + this.#ttlMs,
        expiresAt: now,
        failureReason: reason,
      });
      return { runner, models: [], source: 'unavailable', stale: false, reason };
    }
  }
}

/** One label per runner. A ternary chain defaulted every id it did not name to "OpenCode", so
 *  `pi` — and now `copilot` — would have reported another vendor's outage as their own. */
const RUNNER_LABEL: Record<RunnerId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  pi: 'pi',
  junie: 'Junie',
  copilot: 'GitHub Copilot',
};

function unavailableReason(runner: RunnerId): string {
  return `${RUNNER_LABEL[runner]} model discovery is temporarily unavailable`;
}
