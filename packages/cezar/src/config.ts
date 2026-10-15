import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { loadWorkspaceConfig, type WorkspaceConfig } from './workspace/config.ts';
import { RUNNER_IDS } from './core/agent-runner.ts';

/**
 * Optional advanced config at `.ai/cezar/config.json`. Zero-config rule:
 * a missing file behaves exactly like the default below, an unreadable or
 * invalid file degrades to the default too (never blocks startup). The key
 * can be overridden or emptied (`"skillsRepos": []` disables team skills).
 */
const skillsRepoSchema = z.object({
  /** `owner/name` (GitHub shorthand), a full git URL, or a local/file:// path. */
  repo: z.string().min(1),
  ref: z.string().min(1).default('main'),
});

export type SkillsRepoSource = z.infer<typeof skillsRepoSchema>;

export const DEFAULT_SKILLS_REPOS: SkillsRepoSource[] = [
  { repo: 'open-mercato/skills', ref: 'main' },
];

/** Last-resort retention when neither the repo nor the workspace says anything. */
export const DEFAULT_WORKTREE_RETENTION = 10;

/** Bounds for `worktreeRetention` — shared with the presence probe below, so the
 *  "does this repo set its own?" question is answered by the same rule the
 *  schema enforces (and mirrors the workspace default's bounds). */
const worktreeRetentionSchema = z.number().int().min(0).max(1000);

/**
 * Where a task's agent process runs (spec 2026-09-07-agent-isolation). Absent = `local`, which
 * is every existing install — isolation is opt-in, never inferred.
 *
 * The sandbox is NAMED and reused across tasks by design. A fresh container per
 * task would hand every run a clean image: no `node_modules`, no warm caches, a
 * dependency install before any work. `image` names the template the sandbox is
 * built FROM, so a repo can point at one that already carries its toolchain;
 * after that the running sandbox accumulates state like a dev box does.
 */
const sandboxSchema = z.object({
  /** Run agents inside the sandbox. False/absent keeps them on this machine. */
  enabled: z.boolean().default(false),
  /**
   * Container runtime: podman only. A config naming a runtime cezar no longer supports reads as
   * podman rather than failing to parse.
   */
  provider: z.literal('podman').catch('podman').default('podman'),
  /** Sandbox name, reused across every task in this repo. */
  name: z.string().trim().min(1).max(120).default('cezar'),
  /**
   * The prepared image tasks run in — the repo's toolchain baked in ONCE so no
   * task ever reinstalls it. Unset with podman = `cezar-agent/<name>:latest`,
   * built from `containerfile`.
   */
  image: z.string().trim().min(1).max(300).optional(),
  /**
   * Containerfile the repo's image is built from, relative to the repo root.
   * Ships nothing by itself: `FROM` the cezar agent base and add the toolchain.
   */
  containerfile: z.string().trim().min(1).max(300).default('.ai/cezar/Containerfile'),
  /**
   * Named volumes mounted into every task container, as `volume: mountpoint`.
   * A container per task keeps tasks from polluting each other; these keep
   * package installs warm anyway, which is what makes per-task affordable.
   * Use for SHARED caches (a pnpm/npm store), never for build output.
   */
  cacheVolumes: z.record(z.string(), z.string()).optional().catch(undefined),
  /**
   * Container paths backed by a FRESH anonymous volume per task — `node_modules`
   * being the case that matters.
   *
   * Two problems at once. Such a directory sits inside the bind-mounted repo,
   * where small-file work runs ~15x slower than the VM's own filesystem
   * (measured: 800 file creates, 154ms on the mount vs 10ms on a volume), and
   * it is build output that has no business appearing on the host or leaking
   * between tasks. An anonymous volume shadows the mount at that path: VM
   * speed, invisible to the host, discarded with the container.
   *
   * Pair with a shared store in `cacheVolumes` so the reinstall is local.
   * Note the store and the volume are different filesystems, so pnpm copies
   * rather than hardlinks — still far cheaper than the network or the mount.
   */
  ephemeralPaths: z.array(z.string().trim().min(1)).optional().catch(undefined),
  /**
   * Which of the operator's OTHER credentials the agent may use — gh, gcloud,
   * AWS, kube, Railway, ssh, and anything defined by hand.
   *
   * Nothing is passed unless named here: an isolated agent starts with no
   * credentials at all, and each one is a deliberate widening. `mode` picks the
   * mechanism per credential — `mount` for anything the tool refreshes in place
   * (a cloud CLI's OAuth token), `copy` for static keys, where the container
   * gets a snapshot it cannot write back.
   */
  credentials: z
    .object({
      enabled: z.record(z.string(), z.union([
        z.boolean(),
        z.object({
          mode: z.enum(['mount', 'copy']).optional(),
          // Narrow a directory credential to individual files — `~/.ssh` today.
          // Each is one path segment: these become host AND guest paths.
          keys: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
        }),
      ])).optional(),
      custom: z
        .array(z.object({
          id: z.string().trim().min(1),
          label: z.string().trim().optional(),
          hostPath: z.string().trim().optional(),
          guestPath: z.string().trim().optional(),
          env: z.array(z.string().trim().min(1)).optional(),
          mode: z.enum(['mount', 'copy']).optional(),
          // Where the VALUE is fetched from when it is not on disk or in the
          // cockpit's env — `vault://<mount>/<path>#<field>`. Only a reference
          // is ever stored; the secret itself never lands in a config file.
          valueFrom: z.string().trim().min(1).max(512).optional(),
          required: z.boolean().optional(),
        }))
        .optional(),
    })
    .optional()
    .catch(undefined),
  /**
   * Mount the host's `~/.claude/.credentials.json` into the agent container
   * (Tier 1 passthrough): the agent gets a working login, while `projects/`,
   * `sessions/` and `history.jsonl` — your conversations — stay on the host and
   * out of its reach. Note this shares your IDENTITY: the agent can read that
   * token. Set false and log in inside the container for an independently
   * revocable credential.
   */
  claudeCredentialPassthrough: z.boolean().default(true),
  /**
   * Per-container resource limits. Unset = the container may use whatever the
   * podman VM has, which on macOS is the VM's allocation and NOT the host's —
   * the distinction that makes "why does it only see 8GB" a confusing question.
   *
   * `shmSize` defaults to 1g rather than podman's 64m because a headless
   * Chromium (Playwright, Puppeteer, anything driving a browser in tests)
   * crashes on the default, and the crash reads as an out-of-memory error
   * rather than as a shared-memory one. 64m is right for a container that runs
   * one process; an agent's container is a dev box.
   */
  resources: z
    .object({
      /** e.g. `4g`. Passed to `--memory`. */
      memory: z.string().trim().min(1).max(20).optional(),
      /** e.g. `2`. Passed to `--cpus`. */
      cpus: z.number().positive().max(256).optional(),
      /** e.g. `1g`. Passed to `--shm-size`. */
      shmSize: z.string().trim().min(1).max(20).default('1g'),
    })
    .default({ shmSize: '1g' })
    .catch({ shmSize: '1g' }),
  /** Container-local scratch for the agent. MUST NOT be inside the bind-mounted
   *  workspace: the native claude binary cannot do its startup temp-file work
   *  on that mount and dies with `ENOENT … fstat`. */
  tmpdir: z.string().trim().min(1).max(300).default('/tmp/cez-agent'),
});

export type SandboxConfig = z.infer<typeof sandboxSchema>;

/**
 * The sandbox a repo gets when it has never configured one, for a task that
 * asks for isolation anyway.
 *
 * Without this, the per-task toggle could only ever turn isolation OFF. It is
 * documented as winning "in both directions", but a repo with no `sandbox`
 * block has no provider, and `prepareSandbox` bails before it reaches podman —
 * so a task marked isolated in a fresh project ran on the host. Every project
 * created through "New project" is in exactly that state, as is any repo whose
 * owner never opened Settings → Isolation.
 *
 * Everything but the name comes from the schema's own defaults, so this is the
 * same configuration the Settings switch would have written.
 */
export function defaultSandboxFor(name: string): SandboxConfig {
  return sandboxSchema.parse({ enabled: true, name: sandboxName(name) });
}

/**
 * A container/image name from a repo directory.
 *
 * This becomes an image tag (`cezar-agent/<name>:latest`), so it has to satisfy
 * podman's rules and not merely the config schema's: lowercase, and it must
 * START with an alphanumeric. A directory called `My Repo (v2)` or `...` would
 * otherwise produce a tag podman refuses, and the failure would surface as an
 * unbuildable image rather than as a bad name.
 */
function sandboxName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    // Separators are legal inside the name and illegal at either end.
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '');
  return cleaned.slice(0, 120) || 'cezar';
}

const configSchema = z.object({
  /**
   * Agent isolation (opt-in). `.catch(undefined)` keeps the key additive-safe:
   * a malformed block degrades to "no sandbox" rather than discarding the rest
   * of the config — and failing OPEN to local is the honest default, because a
   * half-parsed sandbox config must never silently look like isolation.
   */
  sandbox: sandboxSchema.optional().catch(undefined),
  skillsRepos: z.array(skillsRepoSchema).default(DEFAULT_SKILLS_REPOS),
  /** How many tasks may run at once (spec 006). Non-git dirs always run 1. */
  maxParallel: z.number().int().min(1).max(16).default(2),
  /**
   * Count-based worktree retention (#483): keep the last N *finished*
   * worktrees materialized on disk; reclaim older ones (directory only — the
   * `cez/<id8>` branch is kept, so the work stays recoverable). 0 = unlimited
   * (never auto-reclaim). Default 10. `.catch(10)` keeps it additive-safe: a
   * bad value degrades to the default instead of discarding the rest.
   */
  worktreeRetention: worktreeRetentionSchema.default(DEFAULT_WORKTREE_RETENTION).catch(DEFAULT_WORKTREE_RETENTION),
  /**
   * Per-task memory ceiling in MiB (whole process tree). When a running task's
   * RSS crosses this the engine pauses it with a warning and lets the queue
   * advance (#memory-guard). 0 / unset = no limit. `.catch(undefined)` keeps
   * the key additive-safe: a bad value degrades to "no limit".
   */
  memoryLimitMb: z.number().int().min(0).max(1_048_576).optional().catch(undefined),
  /**
   * Which agent backend a task uses unless overridden per task (GUI) or per
   * step (workflow). The GUI only offers runners actually installed; this is
   * the preselected default. Also the runner the chain planner uses.
   */
  defaultRunner: z.enum(RUNNER_IDS).default('claude'),
  /** Model for the chain planner (spec 008) — cheap but reliable at JSON. */
  plannerModel: z.string().min(1).default('sonnet'),
  /** Model for the task namer (spec 2026-07-17-task-auto-naming) — the cheapest
   *  alias that answers strict JSON; naming is fire-and-forget and never blocks. */
  namerModel: z.string().min(1).default('haiku'),
  /** Live title updates: refresh the display title through the namer on each
   *  turn end. Absent = the `CEZ_TITLE_UPDATES` env decides (default ON — owner
   *  decision on PR #479). */
  liveTitleUpdates: z.boolean().optional(),
  /** Optional diff-first review gate (#489): when a successful run with changes
   *  should park at `review` for a human. Absent = the `CEZ_REVIEW_GATE` env
   *  decides (default OFF — the deliberate inverse of `liveTitleUpdates`).
   *  Autonomous runs always skip the gate regardless of this. */
  reviewGate: z.boolean().optional(),
  /**
   * Branch task worktrees fork from and draft PRs target (e.g. `develop`).
   * Unset = the branch currently checked out. Settable from the Repo tab.
   */
  baseBranch: z.string().trim().min(1).optional(),
  /**
   * Default extra system prompt applied to every run's agent steps (claude:
   * `--append-system-prompt`; codex/opencode: prepended to the opening user
   * message — the AgentRunSpec seam handles the per-backend delivery).
   * Settings is the single edit place; `POST /api/runs` can override it per
   * run (`systemPrompt`). `.catch(undefined)` keeps the key additive-safe: a
   * bad value degrades to unset without discarding the rest of the config.
   */
  systemPrompt: z.string().trim().min(1).max(20_000).optional().catch(undefined),
  /**
   * Free-text branch naming instructions (spec 2026-10-11-branch-naming-instructions): the
   * creation-time namer derives the task branch from the first prompt under these rules.
   * Absent = `cez/<id8>`. `.catch(undefined)` keeps it additive-safe like `systemPrompt`.
   */
  branchNaming: z.string().trim().min(1).max(4_000).optional().catch(undefined),
  /**
   * Per-runner default model preset (Settings → Agents, redesign R6 1.5): the
   * model id the composer preselects for that runner. Missing = auto (the
   * runner decides). A capability (`model`), never a vendor config format.
   * `.catch(undefined)` keeps the key additive-safe like `systemPrompt`: a
   * bad value degrades to unset without discarding the rest of the config.
   */
  defaultModels: z
    .object({
      claude: z.string().trim().min(1).max(200).optional(),
      codex: z.string().trim().min(1).max(200).optional(),
      opencode: z.string().trim().min(1).max(200).optional(),
      junie: z.string().trim().min(1).max(200).optional(),
      cursor: z.string().trim().min(1).max(200).optional(),
      pi: z.string().trim().min(1).max(200).optional(),
      copilot: z.string().trim().min(1).max(200).optional(),
      kimi: z.string().trim().min(1).max(200).optional(),
    })
    .optional()
    .catch(undefined),
  /**
   * Per-runner "auto is the default" override (#906). Additive and independent
   * of `defaultModels` on purpose: absence of a preset cannot express an
   * explicit auto, because the answer then falls through to the coding agent's
   * OWN settings file — so a user whose `~/.claude/settings.json` names a model
   * had no way to say "ignore that, run with no `--model` flag" short of
   * editing the vendor's file by hand.
   *
   * A separate boolean rather than an `"auto"` sentinel inside `defaultModels`
   * because an older cezar reading this file would pass such a sentinel
   * straight to `--model`; a key it has never heard of it simply ignores.
   * `true` means auto; anything else is no opinion, and the writers delete the
   * key rather than storing `false`.
   */
  defaultModelsAuto: z
    .object({
      claude: z.boolean().optional(),
      codex: z.boolean().optional(),
      opencode: z.boolean().optional(),
      pi: z.boolean().optional(),
      kimi: z.boolean().optional(),
    })
    .optional()
    .catch(undefined),
  /**
   * Make each coding agent's native model setting authoritative. This is an
   * optional repo-level counterpart to `CEZ_AGENT_MODELS_LOCKED=1`; absent or
   * false preserves the ordinary per-runner model selector.
   */
  modelsLocked: z.boolean().optional().catch(undefined),
});

export type CezConfig = z.infer<typeof configSchema>;

/**
 * Fold the machine-wide agent defaults under a repo's own config (spec 2026-07-29-agent-profiles).
 *
 * Applied to the RAW object, before parsing, for the reason `ownWorktreeRetention` documents just
 * below: `defaultRunner`'s `.default('claude')` materializes the key, so after a parse there is no
 * telling "the user chose claude" from "the user said nothing". Merging first keeps the wire shape
 * exactly as it has always been — `defaultRunner` and the model presets stay always-present — while
 * making an absent key mean "ask the machine".
 *
 * A repo key always wins, and `models` merges per RUNNER rather than wholesale: pinning claude's
 * model in one repo must not silently discard the machine's codex preset.
 */
/** A plain object, or undefined — the only shape either side may contribute. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Lay the repo's sandbox block over the machine's template.
 *
 * Repo wins per key, never wholesale: a repo that sets `resources.memory` must
 * not lose the machine's `shmSize` (podman's 64m default kills any headless
 * browser), and one that turns a single credential on must not discard the
 * others the operator granted this machine. Two levels is all that is needed —
 * `resources` and `credentials.enabled` — and merging deeper would start
 * merging a repo's per-credential CHOICE with the machine's, where the repo
 * plainly means to replace it.
 */
function mergeSandboxTemplate(
  machine: unknown,
  own: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const base = asRecord(machine);
  if (!base) return own;
  if (!own) return { ...base };
  const out: Record<string, unknown> = { ...base, ...own };
  const resources = { ...asRecord(base.resources), ...asRecord(own.resources) };
  if (Object.keys(resources).length > 0) out.resources = resources;
  const baseCredentials = asRecord(base.credentials);
  const ownCredentials = asRecord(own.credentials);
  if (baseCredentials || ownCredentials) {
    const enabled = { ...asRecord(baseCredentials?.enabled), ...asRecord(ownCredentials?.enabled) };
    // Secrets merge by id too. Letting the repo's list replace the machine's
    // meant a project that added ONE secret silently lost every machine-wide
    // one — the opposite of "the repo wins per key".
    const byId = new Map<string, unknown>();
    for (const list of [baseCredentials?.custom, ownCredentials?.custom]) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const id = asRecord(entry)?.id;
        if (typeof id === 'string') byId.set(id, entry);
      }
    }
    out.credentials = {
      ...baseCredentials,
      ...ownCredentials,
      ...(Object.keys(enabled).length > 0 ? { enabled } : {}),
      ...(byId.size > 0 ? { custom: [...byId.values()] } : {}),
    };
  }
  const cacheVolumes = { ...asRecord(base.cacheVolumes), ...asRecord(own.cacheVolumes) };
  if (Object.keys(cacheVolumes).length > 0) out.cacheVolumes = cacheVolumes;
  return out;
}

function withMachineDefaults(
  raw: unknown,
  machine: WorkspaceConfig['agentDefaults'],
  /** The repo directory, used to name a sandbox the repo did not name itself. */
  repoName?: string,
): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const own = raw as Record<string, unknown>;
  const ownModels = own.defaultModels && typeof own.defaultModels === 'object'
    ? own.defaultModels as Record<string, unknown>
    : undefined;
  const models = { ...machine.models, ...ownModels };
  // The machine's isolation default applies only where the repo's `sandbox`
  // block is SILENT about `enabled` — a repo that says `false` means false, and
  // the machine must not override a deliberate choice with its own.
  const ownSandbox = own.sandbox && typeof own.sandbox === 'object' && !Array.isArray(own.sandbox)
    ? own.sandbox as Record<string, unknown>
    : undefined;
  // The machine's sandbox TEMPLATE is the base the repo writes over. Which
  // credentials agents may use, how big a container may get and which caches
  // they share are properties of this machine; a repo that states one wins for
  // that key, and a repo that says nothing inherits instead of getting the bare
  // schema default. `credentials.enabled` and `resources` merge one level down,
  // so a repo that pins only `resources.memory` keeps the machine's shm.
  const merged = mergeSandboxTemplate(machine.sandbox, ownSandbox);
  let sandbox = machine.isolation !== undefined && merged?.enabled === undefined
    ? { ...(merged ?? {}), enabled: machine.isolation }
    : merged;
  // Name the sandbox after the repo unless the repo named it. The schema's
  // literal default would otherwise have every project that never picked a name
  // share one image tag (`cezar-agent/cezar:latest`) — which, once machine-wide
  // defaults exist, is every unconfigured project on the machine.
  if (sandbox && sandbox.name === undefined && repoName) {
    sandbox = { ...sandbox, name: sandboxName(repoName) };
  }

  return {
    ...own,
    ...(sandbox ? { sandbox } : {}),
    ...(own.defaultRunner === undefined && machine.runner !== undefined
      ? { defaultRunner: machine.runner }
      : {}),
    ...(Object.keys(models).length > 0 ? { defaultModels: models } : {}),
  };
}

/**
 * Read `.ai/cezar/config.json` on demand — never cached, never throws.
 *
 * Also reads the machine-wide defaults, which is one more small JSON read and deliberately not
 * cached for the same reason this one is not: `~/.cezar/` is shared by every cezar process on the
 * machine, so a snapshot is a staleness bug.
 */
export async function loadConfig(repoRoot: string): Promise<CezConfig> {
  const machine = (await loadWorkspaceConfig()).agentDefaults;
  const repoName = basename(repoRoot);
  const local = await readLocalGrants(repoRoot);
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, '.ai/cezar', 'config.json'), 'utf8');
  } catch {
    return configSchema.parse(withMachineDefaults(withLocalGrants({}, local), machine, repoName));
  }
  try {
    const own = JSON.parse(raw) as unknown;
    const trusted = (await configIsTracked(repoRoot)) ? withoutGrants(own) : own;
    const parsed = configSchema.safeParse(withMachineDefaults(withLocalGrants(trusted, local), machine, repoName));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through — malformed JSON degrades to the default
  }
  return configSchema.parse(withMachineDefaults(withLocalGrants({}, local), machine, repoName));
}

/**
 * The machine-local file a project's credential GRANTS live in when its `config.json` is
 * committed. Git-ignored (`DATA_GITIGNORE_ENTRIES`), so nothing in it ever arrives with a clone.
 */
export const LOCAL_CONFIG_FILE = 'config.local.json';

/**
 * Keys of a repo's `sandbox` block that hand the container something of the OPERATOR's: which
 * credentials it gets, which host paths and secrets (`credentials`), and which volumes it mounts
 * (`cacheVolumes`, whose key used to be able to name a host path). A committed config.json is
 * written by whoever committed it — a cloned repo would otherwise grant itself `~/.ssh`, `~/.aws`
 * or a Vault secret by shipping a file. So a TRACKED config.json may describe its image but not
 * grant; grants come from an untracked config.json (cezar wrote it here) or `config.local.json`.
 */
const GRANT_KEYS = ['credentials', 'cacheVolumes'] as const;

function withoutGrants(raw: unknown): unknown {
  const own = asRecord(raw);
  const sandbox = asRecord(own?.sandbox);
  if (!own || !sandbox) return raw;
  const kept = { ...sandbox };
  for (const key of GRANT_KEYS) delete kept[key];
  return { ...own, sandbox: kept };
}

async function readLocalGrants(repoRoot: string): Promise<Record<string, unknown> | undefined> {
  try {
    return asRecord(asRecord(JSON.parse(await readFile(join(repoRoot, '.ai/cezar', LOCAL_CONFIG_FILE), 'utf8')))?.sandbox);
  } catch {
    return undefined;
  }
}

/** Lay `config.local.json`'s grants over the repo's — same per-key merge as the machine template. */
function withLocalGrants(raw: unknown, local: Record<string, unknown> | undefined): unknown {
  if (!local) return raw;
  const own = asRecord(raw) ?? {};
  const grants: Record<string, unknown> = {};
  for (const key of GRANT_KEYS) if (local[key] !== undefined) grants[key] = local[key];
  if (Object.keys(grants).length === 0) return raw;
  return { ...own, sandbox: mergeSandboxTemplate(asRecord(own.sandbox) ?? {}, grants) };
}

const trackedCache = new Map<string, { tracked: boolean; at: number }>();

/**
 * Is `.ai/cezar/config.json` tracked by git in `repoRoot`? Cached briefly — `loadConfig` runs
 * per turn and per request. An unanswerable question (no git, not a repo) answers false: the file
 * then is this machine's, which is what an untracked file means.
 */
export function configIsTracked(repoRoot: string): Promise<boolean> {
  const cached = trackedCache.get(repoRoot);
  if (cached && Date.now() - cached.at < 30_000) return Promise.resolve(cached.tracked);
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '--error-unmatch', '--', '.ai/cezar/config.json'],
      { cwd: repoRoot, timeout: 5_000 },
      (error) => {
        const tracked = !error;
        trackedCache.set(repoRoot, { tracked, at: Date.now() });
        resolve(tracked);
      },
    );
  });
}

/**
 * The repo's OWN `worktreeRetention`, or `undefined` when it doesn't set one.
 *
 * `loadConfig` cannot answer this: the schema's `.default(10).catch(10)`
 * materializes the key, so a parsed config can't tell "the user chose 10" from
 * "the user said nothing". So we probe the raw file — a key that is absent (or
 * carries a value the schema would refuse) means the repo has no opinion, and
 * the workspace default gets to seed it.
 */
async function ownWorktreeRetention(repoRoot: string): Promise<number | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, '.ai/cezar', 'config.json'), 'utf8');
  } catch {
    return undefined; // no file — nothing set
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const value = (parsed as Record<string, unknown>).worktreeRetention;
    if (value === undefined) return undefined;
    const field = worktreeRetentionSchema.safeParse(value);
    return field.success ? field.data : undefined;
  } catch {
    return undefined; // malformed JSON — same as unset
  }
}

/**
 * The default skills repos that are *opt-in per skill* (the "import OM skills"
 * flow): the set of repo identifiers a user must explicitly import from before
 * their skills join the catalog. This is exactly `DEFAULT_SKILLS_REPOS` when the
 * repo has NOT configured its own `skillsRepos` — the zero-config majority — and
 * empty once a repo takes control by setting `skillsRepos` (then everything it
 * lists auto-loads, unchanged).
 *
 * `loadConfig` cannot answer this: the schema's `.default(DEFAULT_SKILLS_REPOS)`
 * materializes the key, so a parsed config can't tell "the user chose these" from
 * "the user said nothing". So we probe the raw file for the key's presence — the
 * same reason `ownWorktreeRetention` below reads the raw JSON.
 */
export async function gatedSkillsRepos(repoRoot: string): Promise<Set<string>> {
  const none = new Set<string>();
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, '.ai/cezar', 'config.json'), 'utf8');
  } catch {
    // No file — the defaults are in effect, so they are the opt-in set.
    return new Set(DEFAULT_SKILLS_REPOS.map((r) => r.repo));
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return new Set(DEFAULT_SKILLS_REPOS.map((r) => r.repo));
    }
    // The user took control of the source list — nothing is gated; a value the
    // schema would refuse degrades to the default too (same as `loadConfig`).
    if ((parsed as Record<string, unknown>).skillsRepos !== undefined) return none;
    return new Set(DEFAULT_SKILLS_REPOS.map((r) => r.repo));
  } catch {
    // Malformed JSON degrades to the default (which loadConfig also does).
    return new Set(DEFAULT_SKILLS_REPOS.map((r) => r.repo));
  }
}

/**
 * Effective worktree retention for a repo (#483 + spec
 * 2026-07-20-multi-project-workspace). Precedence, exactly what Settings →
 * Worktrees promises: the repo's own `worktreeRetention` wins whenever it sets
 * one; otherwise the workspace's `resources.worktreeRetentionDefault` seeds it;
 * an absent/unreadable workspace config keeps the historical 10. Every
 * enforcement site (boot sweeps, terminal transitions, the reclaim route) must
 * go through here so the setting can never be a lie.
 */
export async function resolveWorktreeRetention(repoRoot: string): Promise<number> {
  const own = await ownWorktreeRetention(repoRoot);
  if (own !== undefined) return own;
  const workspace = await loadWorkspaceConfig().catch(() => null);
  return workspace?.resources.worktreeRetentionDefault ?? DEFAULT_WORKTREE_RETENTION;
}
