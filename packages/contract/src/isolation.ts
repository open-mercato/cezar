import { z } from 'zod';

/**
 * Agent isolation — running a task's agent inside a container instead of on the
 * host — as seen by the cockpit.
 *
 * Two facts are needed wherever this is offered, and they are different
 * questions with different answers:
 *
 *  - CAN this machine isolate? (is a container runtime installed, is its VM up)
 *  - SHOULD this project isolate? (the operator's setting)
 *
 * Collapsing them into one boolean is what makes an isolation toggle
 * unexplainable: "off" would mean both "you turned it off" and "your VM is
 * stopped", which need different words and different fixes. So the status
 * carries a human-readable `reason` and, where one exists, the single `fix`
 * command that resolves it.
 */
export const containerRuntimeStatusSchema = z.object({
  /** Isolation can be used right now. */
  ready: z.boolean(),
  provider: z.literal('podman'),
  installed: z.boolean(),
  version: z.string().optional(),
  /** macOS/Windows run containers in a VM; on Linux this is always true. */
  machineRunning: z.boolean(),
  machineName: z.string().optional(),
  /** One actionable sentence. Empty when `ready`. */
  reason: z.string(),
  /** The exact command that fixes `reason`, when one command does. */
  fix: z.string().optional(),
});
export type ContainerRuntimeStatus = z.infer<typeof containerRuntimeStatusSchema>;

/** `GET /api/v1/projects/:id/isolation` — what Settings and the composer read. */
export const isolationStatusResponseSchema = z.object({
  runtime: containerRuntimeStatusSchema,
  /** The project's own setting, as configured. */
  enabled: z.boolean(),
  /**
   * What a task started right now would actually do. `enabled && runtime.ready`
   * — the composer shows THIS, because a toggle that says "on" while the VM is
   * stopped is a lie the run would then have to correct in its own log.
   */
  effective: z.boolean(),
  /** The image tasks would run in, so Settings can name it. */
  image: z.string(),
  /** Whether the repo has its own Containerfile, or is on the generic base. */
  hasContainerfile: z.boolean(),
  /**
   * Installs cezar noticed this project's agents performing, proposed for the
   * image. Observation, not configuration: accepting one is what turns it into
   * a `Containerfile` the user then owns, and nothing is written before that.
   */
  suggestions: z.array(z.object({
    command: z.string(),
    manager: z.enum(['apt', 'npm', 'pnpm', 'yarn', 'pip', 'pipx', 'go', 'cargo', 'gem', 'apk', 'dnf']),
  })).default([]),
  /**
   * Per-container limits. On macOS these cap a container within the podman VM's
   * OWN allocation, not the host's — which is why a task can report 8GB on a
   * 32GB machine, and why the VM size is a separate thing to raise.
   */
  resources: z.object({
    memory: z.string().optional(),
    cpus: z.number().optional(),
    shmSize: z.string(),
  }),
  /**
   * Which of the operator's credentials the agent may use.
   *
   * `catalog` is what this machine offers, with `present` saying whether the
   * file is actually there — a credential the operator does not have must read
   * as unavailable rather than as "off", because the two suggest different next
   * steps. `enabled` and `custom` are the project's choices.
   */
  credentials: z.object({
    catalog: z.array(z.object({
      id: z.string(),
      label: z.string(),
      /** A single file is always COPIED (see `resolvePassthrough`), so the page offers mount/copy
       *  only for a directory. */
      kind: z.enum(['file', 'dir']),
      hostPath: z.string().optional(),
      env: z.array(z.string()).default([]),
      defaultMode: z.enum(['mount', 'copy']),
      note: z.string().optional(),
      present: z.boolean(),
      /**
       * Individual files this credential can be narrowed to, discovered on the
       * host — today only `~/.ssh`. All-or-nothing is a real hazard there: one
       * directory mount hands the container every host every key reaches, so
       * the UI offers the files and the operator ticks the ones the task needs.
       * Selected files are COPIED whatever `mode` says (see the core module).
       */
      entries: z.array(z.object({
        name: z.string(),
        kind: z.enum(['private-key', 'config', 'known-hosts']),
        /** `ed25519 · kamil@mac`, when the matching `.pub` says so. */
        detail: z.string().optional(),
      })).default([]),
    })).default([]),
    enabled: z.record(z.string(), z.union([
      z.boolean(),
      z.object({
        mode: z.enum(['mount', 'copy']).optional(),
        /** Narrowed file picks; empty or absent means the whole directory. */
        keys: z.array(z.string()).optional(),
      }),
    ])).default({}),
    custom: z.array(z.object({
      id: z.string(),
      label: z.string().optional(),
      hostPath: z.string().optional(),
      guestPath: z.string().optional(),
      env: z.array(z.string()).optional(),
      mode: z.enum(['mount', 'copy']).optional(),
      /**
       * Where the value is fetched from — `vault://<mount>/<path>#<field>`.
       * A REFERENCE, never a value: this is served over the API, so a secret
       * here would be readable by anything that can read the settings page.
       */
      valueFrom: z.string().optional(),
      /** Fail the step when it cannot be fetched, instead of running without it. */
      required: z.boolean().optional(),
    })).default([]),
    /**
     * The repo's OWN choices, without what it inherits from the machine.
     *
     * `enabled` and `custom` above are the EFFECTIVE view, for display. The
     * per-project page edits `own`: writing the effective view back pinned every
     * machine-wide grant into the repo, so revoking it machine-wide later had no
     * effect there.
     */
    own: z.object({
      enabled: z.record(z.string(), z.unknown()).default({}),
      custom: z.array(z.unknown()).default([]),
    }).default({ enabled: {}, custom: [] }),
  }),
});
export type IsolationStatusResponse = z.infer<typeof isolationStatusResponseSchema>;

/**
 * `GET /api/v1/vault/status` and `/api/v1/vault/browse` — what the secret
 * picker reads.
 *
 * NAMES ONLY, at every level. A secret's value is fetched on the host when a
 * container starts and goes straight into it; nothing here may put one on the
 * wire, because this is served to a browser. The picker's whole job is to turn
 * "which key do I want" into a `vault://mount/path#field` reference.
 */
export const vaultStatusResponseSchema = z.object({
  installed: z.boolean(),
  address: z.string().optional(),
  authenticated: z.boolean(),
  /** One actionable sentence; empty when ready. */
  reason: z.string(),
  fix: z.string().optional(),
  /** The KV mounts this token can see. Empty unless authenticated. */
  mounts: z.array(z.string()).default([]),
  /**
   * Why `mounts` is empty, when it is for a reason other than "there are none".
   *
   * `sys/mounts` needs privileges a sensibly-scoped token does not have, so
   * this is the NORMAL case for a real token rather than a failure — the
   * picker lets the operator type the mount name instead.
   */
  mountsError: z.string().optional(),
});
export type VaultStatusResponse = z.infer<typeof vaultStatusResponseSchema>;

export const vaultBrowseResponseSchema = z.object({
  mount: z.string(),
  path: z.string(),
  /** Child paths at this level; a folder keeps its trailing slash. */
  entries: z.array(z.string()).default([]),
  /** Field names of the secret AT this path, when it is one. Never values. */
  fields: z.array(z.string()).default([]),
  /**
   * Why a level came back empty. The common one is a policy granting `list`
   * but not `read`: the path shows up, its fields do not, and without this the
   * picker would say "nothing here" about a secret that is plainly there — and
   * about a value no task would be able to fetch either.
   */
  error: z.string().optional(),
});
export type VaultBrowseResponse = z.infer<typeof vaultBrowseResponseSchema>;

/**
 * `GET /api/v1/vault/browse` query. Validated as route middleware like every
 * other query in the API, so the shape reaches `AppType` and the typed client
 * instead of being parsed by hand inside the handler.
 *
 * Strict for the same reason the reference parser is: both become argv entries
 * to the `vault` CLI, and a loosely accepted one would surface as vault's own
 * error about a malformed path rather than as a bad request.
 */
export const vaultBrowseQuerySchema = z.object({
  mount: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'mount must be a single KV mount name'),
  path: z
    .string()
    .trim()
    .transform((p) => p.replace(/^\/+|\/+$/g, ''))
    .refine((p) => p === '' || isVaultBrowsePath(p), 'path must be a KV path')
    .default(''),
});

/**
 * A KV path as real Vaults spell them — spaces, a leading `_`, `@`, letters in
 * any script — while still refusing what could be read as something else:
 * a `.`/`..` segment, an empty segment, a leading `-` (the path is one argv
 * entry, so a flag is the only other thing it could be), `#` (the reference's
 * field separator), and every control character, NUL and newline included.
 * Bounded at 512.
 *
 * Mirrors `isVaultKvPath` in packages/cezar/src/core/vault-secrets.ts, which
 * decides whether a picked reference can be fetched; the contract is Node-free
 * and cannot import it, so vault-browse.test.ts runs both over one table.
 */
function isVaultBrowsePath(path: string): boolean {
  if (path.length > 512 || path.startsWith('-')) return false;
  return path
    .split('/')
    .every((segment) => segment !== '.' && segment !== '..' && /^[\p{L}\p{N}\p{M} ._@+=,:~-]+$/u.test(segment));
}
export type VaultBrowseQuery = z.infer<typeof vaultBrowseQuerySchema>;
