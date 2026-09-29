import { z } from 'zod';

/**
 * Self-update (`/api/v1/workspace/self-update`, PoC — spec to follow): the cockpit's own
 * "update cezar" surface. cezar can only replace ITSELF when it runs from the managed layout
 * (`~/.cezar/versions/<id>`, activated through the `current` link and launched by
 * `~/.cezar/bin/cezar`); every other install kind is reported so the dialog can explain how to
 * get there instead of failing a download nobody can use.
 */

/** Release channels map onto npm dist-tags: `stable` → `latest`, `nightly` → `nightly`. */
export const updateChannelSchema = z.enum(['stable', 'nightly']);
export type UpdateChannel = z.infer<typeof updateChannelSchema>;

/** How the running process was installed — decides whether a self-update is possible. */
export const installKindSchema = z.enum(['managed', 'global-npm', 'npx', 'checkout', 'unknown']);
export type InstallKind = z.infer<typeof installKindSchema>;

/** One entry under `~/.cezar/versions/`. `id` is the directory name; a local build carries a
 *  `+local` suffix so it never collides with the registry version it was built from, and a
 *  linked checkout (`link`, `cezar link`) a `+<branch>` one. */
export const installedVersionSchema = z.object({
  id: z.string(),
  version: z.string(),
  source: z.enum(['registry', 'local', 'link']),
  installedAt: z.string(),
  active: z.boolean(),
  /** `link` only: the checkout's branch, and its package root (absent in hosted mode). */
  branch: z.string().optional(),
  checkout: z.string().optional(),
});
export type InstalledVersion = z.infer<typeof installedVersionSchema>;

/** One registry version the picker can install. `channel` is the dist-tag family it belongs to:
 *  a plain semver is `stable`, `-nightly.` a nightly, anything else (`-develop.`, `-pr123.`) a
 *  `preview`. `publishedAt` comes from the registry's `time` map, null when it is missing. */
export const availableVersionSchema = z.object({
  version: z.string(),
  channel: z.enum(['stable', 'nightly', 'preview']),
  publishedAt: z.string().nullable(),
  installed: z.boolean(),
});
export type AvailableVersion = z.infer<typeof availableVersionSchema>;

export const selfUpdateJobStatusSchema = z.enum(['running', 'failed', 'restarting']);

/** A cezar checkout (a worktree of a registered cezar repo) the cockpit can switch to by
 *  applying its `id` — linked on the spot, no copy, no publish. Only built ones can be applied.
 *  Always empty in hosted mode. */
export const cezarCheckoutSchema = z.object({
  id: z.string(),
  branch: z.string(),
  version: z.string(),
  worktree: z.string(),
  built: z.boolean(),
  linked: z.boolean(),
});
export type CezarCheckout = z.infer<typeof cezarCheckoutSchema>;

/** The one in-flight or last-finished install job. `log` is npm's own output, line by line,
 *  capped server-side. `restarting` means the new version is activated and the process is about
 *  to exit — the cockpit polls health until a different `version` answers. */
export const selfUpdateJobSchema = z.object({
  status: selfUpdateJobStatusSchema,
  target: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  log: z.array(z.string()),
  error: z.string().optional(),
});
export type SelfUpdateJob = z.infer<typeof selfUpdateJobSchema>;

/** `GET /api/v1/workspace/self-update` (and every mutation on the family). */
export const selfUpdateStatusSchema = z.object({
  version: z.string(),
  installKind: installKindSchema,
  /** Absolute entry file the process runs; hosted mode trims it to its basename. */
  entry: z.string(),
  canSelfUpdate: z.boolean(),
  /** Why `canSelfUpdate` is false, phrased for the dialog. Absent when it is true. */
  reason: z.string().optional(),
  channel: updateChannelSchema,
  /** How the process will come back: re-exec itself, or exit and let the supervisor (desktop
   *  shell, systemd, launchd) relaunch it. */
  restartMode: z.enum(['reexec', 'supervisor']),
  latest: z.object({
    stable: z.string().nullable(),
    nightly: z.string().nullable(),
  }),
  /** The channel's newest version when it is newer than `version`, else null. */
  updateAvailable: z.string().nullable(),
  /** When the registry was last read successfully; null when it never answered (offline). */
  checkedAt: z.string().nullable(),
  installed: z.array(installedVersionSchema),
  available: z.array(availableVersionSchema),
  /** Optional so an older server's answer still parses. */
  checkouts: z.array(cezarCheckoutSchema).optional(),
  job: selfUpdateJobSchema.nullable(),
  /** Runs in flight across the workspace — a restart interrupts them (boot recovery re-queues). */
  activeRuns: z.number().int().min(0),
});
export type SelfUpdateStatus = z.infer<typeof selfUpdateStatusSchema>;

/** `POST /api/v1/workspace/self-update/apply` — a version string, never a URL or a path. */
export const selfUpdateApplyRequestSchema = z
  .object({
    version: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[0-9A-Za-z.+-]+$/, 'version must be a plain version string'),
  })
  .strict();
export type SelfUpdateApplyRequest = z.infer<typeof selfUpdateApplyRequestSchema>;

/** `PUT /api/v1/workspace/self-update/channel`. */
export const selfUpdateChannelRequestSchema = z.object({ channel: updateChannelSchema }).strict();
export type SelfUpdateChannelRequest = z.infer<typeof selfUpdateChannelRequestSchema>;
