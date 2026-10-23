import { z } from 'zod';

/**
 * Cockpit telemetry (`/api/v1/telemetry/*`). The telemetry worker sends no CORS headers, so the
 * browser reports through the local server, which forwards only once the user opted in (see
 * `/telemetry/consent` below). The relay routes answer `204` with no body.
 */

/**
 * `GET`/`PUT /api/v1/telemetry/consent` — the opt-in answer, stored in `~/.cezar/config.json`.
 * `unknown` (never asked, or asked about an older `policyVersion`) and `denied` send nothing.
 * `blockedBy`: `env` — `CEZ_TELEMETRY=0`/`DO_NOT_TRACK=1` override any answer; `automation` —
 * CI, test runners, `CEZ_DRY_RUN=1`, where the cockpit never asks.
 */
export const telemetryConsentSchema = z.object({
  consent: z.enum(['unknown', 'granted', 'denied']),
  policyVersion: z.number().int(),
  blockedBy: z.enum(['env', 'automation']).nullable(),
  endpoint: z.string(),
});
export type TelemetryConsentPayload = z.infer<typeof telemetryConsentSchema>;

export const setTelemetryConsentInputSchema = z.object({ consent: z.enum(['granted', 'denied']) });
export type SetTelemetryConsentInput = z.infer<typeof setTelemetryConsentInputSchema>;

/**
 * A route SHAPE, never a real path: static segments stay, every user value (project slug, run
 * id, PR number, workflow name) is `:param` — `/p/:param/tasks/:param/changes`. Forwarded as
 * `page_viewed` with the shape as its `label`, so a journey reads as the click path. The server
 * enforces the vocabulary below, so nothing identifying can pass even if a client sent a raw
 * path. ≤64 is the worker's `label` limit.
 */
/** The static URL segments cockpit routes are made of. A segment outside this list is the
 *  user's data and must arrive as `:param`. */
export const TELEMETRY_ROUTE_SEGMENTS: readonly string[] = [
  'p', 'new', 'tasks', 'changes', 'files', 'commits', 'compare', 'git', 'branches', 'log',
  'github', 'prs', 'issues', 'tracker', 'skills', 'inbox', 'workflows', 'automations',
  'dashboard', 'settings', 'global', 'agents', 'agent-config', 'worktrees', 'bookmarklets',
  'prompt-templates', 'appearance', 'notifications', 'resources', 'accounts', 'projects',
  'keyboard', 'graph', 'integrations', 'secrets', 'workflows-new', 'workspace-secrets', 'privacy',
];

export const telemetryRouteSchema = z
  .string()
  .max(64)
  .refine(
    (route) =>
      route.startsWith('/') &&
      route
        .split('/')
        .slice(1)
        .every((segment, i, all) =>
          segment === '' ? all.length === 1 : segment === ':param' || TELEMETRY_ROUTE_SEGMENTS.includes(segment),
        ),
    { message: 'a route shape: known segments and :param only' },
  );

export const telemetryPageInputSchema = z.object({ route: telemetryRouteSchema });
export type TelemetryPageInput = z.infer<typeof telemetryPageInputSchema>;

/** One flat wide-event field: the worker keeps strings ≤1024, numbers, booleans and null. */
export const telemetryContextValueSchema = z.union([z.string().max(1024), z.number(), z.boolean(), z.null()]);

/**
 * An uncaught cockpit error, reported as ONE wide event (https://loggingsucks.com/): everything
 * known about the page, the session and the build rides in `context` as flat dotted keys
 * (`page.route`, `build.entry`, `client.engine`…), so a report answers "what happened to this
 * user" without a second search. The server relay adds its own half (server build, uptime,
 * whether the page's bundle is still the one being served) before forwarding. Bounds match the
 * worker's own limits; the client truncates.
 */
export const telemetryErrorInputSchema = z.object({
  type: z.string().max(128),
  message: z.string().max(2048),
  stack: z.string().max(16_384).optional(),
  handler: z.string().max(64).optional(),
  /** Stable machine-readable code, e.g. `chunk_load_failed`. */
  code: z.string().max(128).optional(),
  /** Custom grouping key, for errors whose stack/message differ per engine. */
  fingerprint: z.string().max(128).optional(),
  context: z
    .record(z.string().max(64), telemetryContextValueSchema)
    .refine((ctx) => Object.keys(ctx).length <= 32, { message: 'at most 32 context keys' })
    .optional(),
});
export type TelemetryErrorInput = z.infer<typeof telemetryErrorInputSchema>;

/** Where a user's message to an agent came from — `message_sent`'s label. A closed set, so a
 *  dashboard's breakdown has exactly these rows. `cli` is sent by the server for `cezar run`. */
export const MESSAGE_SURFACES = [
  'new_task',
  'bookmarklet',
  'existing_session',
  'ask_answer',
  // The run header's git buttons (Create PR, Push, Update branch, …), sent to the task's agent.
  'git_step',
  'review',
  'github',
  'tracker',
  'inbox',
  'skills_import',
  'cli',
] as const;
export const messageSurfaceSchema = z.enum(MESSAGE_SURFACES);
export type MessageSurface = z.infer<typeof messageSurfaceSchema>;

/** The "Add project" dialogs — `add_project_opened`'s label. */
export const ADD_PROJECT_DIALOGS = ['new', 'clone', 'folder'] as const;
export const addProjectDialogSchema = z.enum(ADD_PROJECT_DIALOGS);
export type AddProjectDialog = z.infer<typeof addProjectDialogSchema>;

/** How many attachments a message carried — `attachments_sent`'s label (telemetry 7054e5f2). */
export const ATTACHMENT_COUNT_BUCKETS = ['1', '2-4', '5-10', '11-20'] as const;
export const attachmentCountBucketSchema = z.enum(ATTACHMENT_COUNT_BUCKETS);
export type AttachmentCountBucket = z.infer<typeof attachmentCountBucketSchema>;

/** The count's bucket; anything past the cap lands in the last one. */
export function attachmentCountBucket(count: number): AttachmentCountBucket {
  if (count <= 1) return '1';
  if (count <= 4) return '2-4';
  if (count <= 10) return '5-10';
  return '11-20';
}

/** Which button archived or pinned a task — the label of `task_(un)archived` / `task_(un)pinned`.
 *  Sent as `surface` in the archive/pin body; absent (a non-cockpit caller) labels as `api`. */
export const TASK_ACTION_SURFACES = ['sidebar', 'tasks_table', 'all_tasks', 'task_view', 'palette', 'shortcut'] as const;
export const taskActionSurfaceSchema = z.enum(TASK_ACTION_SURFACES);
export type TaskActionSurface = z.infer<typeof taskActionSurfaceSchema>;

/**
 * The task-palette commands, as telemetry names them (spec 2026-10-17-task-palette) — the label of
 * `task_command_run` and `task_shortcut_used`. The palette's own command ids, with the open-ended
 * ones folded: every saved layout is `layout`, every "Open in…" target `open`, every ⌘1–⌘9 `tab`.
 */
export const TASK_COMMAND_LABELS = [
  'reply', 'toggle-read', 'pin', 'archive', 'rename', 'end-session', 'accept', 'stop', 'delete',
  'git:commit', 'git:commit-push', 'git:push', 'git:create-pr', 'git:create-draft-pr',
  'git:update-branch', 'git:resolve-conflicts', 'git:fix-checks', 'open-pr',
  'view:session', 'view:graph', 'view:changes', 'view:commits', 'view:files', 'view:browser',
  'view:terminal', 'view:notes', 'tab',
  'layout', 'layout:new', 'full-view', 'split', 'terminal', 'terminal-column',
  'open', 'open:terminal-resume',
  'copy:link', 'copy:branch', 'copy:path', 'copy:resume', 'copy:pr', 'copy:id',
] as const;
export const taskCommandLabelSchema = z.enum(TASK_COMMAND_LABELS);
export type TaskCommandLabel = z.infer<typeof taskCommandLabelSchema>;

/** A palette command id → its telemetry label, or undefined for one telemetry does not name. */
export function taskCommandLabel(id: string): TaskCommandLabel | undefined {
  if (id.startsWith('tab:')) return 'tab';
  if (id.startsWith('layout:') && id !== 'layout:new') return 'layout';
  if (id.startsWith('open:') && id !== 'open:terminal-resume') return 'open';
  return (TASK_COMMAND_LABELS as readonly string[]).includes(id) ? (id as TaskCommandLabel) : undefined;
}

/** Which palette opened — `palette_opened`'s label. `task_switch` is ⌘P off a task page. */
export const PALETTE_KINDS = ['command', 'task', 'task_switch'] as const;
/** How the user moved to another task — `task_switched`'s label. `cycle` is ⌘P ⌘P… then ↵;
 *  `tab` acts on a task without opening it; the `cmdk` pair are the same two from ⌘K. */
export const TASK_SWITCH_WAYS = ['enter', 'cycle', 'tab', 'cmdk', 'cmdk_tab'] as const;
/** What a palette session searched with — `palette_mode_used`'s label: a prefix (`@` tasks, `>`
 *  commands, `#` files), or a search shape (`pr_number`, `automation`). Never the text itself. */
export const PALETTE_MODES = ['tasks', 'commands', 'files', 'pr_number', 'automation'] as const;
/** The view a palette was closed from without choosing anything — `palette_dismissed`'s label. */
export const PALETTE_DISMISS_VIEWS = ['command', 'actions', 'tasks', 'files'] as const;

/** A batched count: high-volume events (a shortcut can fire constantly) are summed in the tab and
 *  sent once per label with `value` (docs/telemetry.md). */
const batchedValue = z.number().int().min(1).max(1000).optional();

/** How a skills-update apply whose request got no answer ended — `skills_update_apply_dropped`'s
 *  label (telemetry edd8c83e). */
export const SKILLS_UPDATE_DROP_OUTCOMES = ['recovered', 'not_applied', 'unreachable', 'timed_out'] as const;
export const skillsUpdateDropOutcomeSchema = z.enum(SKILLS_UPDATE_DROP_OUTCOMES);
export type SkillsUpdateDropOutcome = z.infer<typeof skillsUpdateDropOutcomeSchema>;

/**
 * `POST /api/v1/telemetry/event` — a user action only the cockpit can name. Every event has its
 * own closed label set, so this relay can never carry free text. `204`, like the other two.
 */
export const telemetryEventInputSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('message_sent'), label: messageSurfaceSchema.exclude(['cli']) }),
  /** A review comment left on the Changes tab's diff: on one line, or on a selected range. */
  z.object({ event: z.literal('diff_comment_added'), label: z.enum(['single_line', 'multi_line']) }),
  /** One of the sidebar's "Add project" dialogs was opened: New project, Clone from GitHub, or
   *  Open local folder. With `project_added`, the funnel of each add flow. */
  z.object({ event: z.literal('add_project_opened'), label: addProjectDialogSchema }),
  /** A sent message carried attachments, bucketed by how many. */
  z.object({ event: z.literal('attachments_sent'), label: attachmentCountBucketSchema }),
  /** A send hit an expired staged upload; the composer re-staged and resent once — the outcome. */
  z.object({ event: z.literal('attachments_restaged'), label: z.enum(['recovered', 'failed']) }),
  /** A skills-update apply lost its connection, and how following the server's state ended. */
  z.object({ event: z.literal('skills_update_apply_dropped'), label: skillsUpdateDropOutcomeSchema }),
  /** ⌘K or ⌘P opened (spec 2026-10-17-task-palette). */
  z.object({ event: z.literal('palette_opened'), label: z.enum(PALETTE_KINDS) }),
  /** A ⌘P command ran from the palette — batched. */
  z.object({ event: z.literal('task_command_run'), label: taskCommandLabelSchema, value: batchedValue }),
  /** A task command ran from its keyboard shortcut — batched. */
  z.object({ event: z.literal('task_shortcut_used'), label: taskCommandLabelSchema, value: batchedValue }),
  /** The user moved to another task from a palette. */
  z.object({ event: z.literal('task_switched'), label: z.enum(TASK_SWITCH_WAYS) }),
  /** A palette session searched this way (once per session per mode). */
  z.object({ event: z.literal('palette_mode_used'), label: z.enum(PALETTE_MODES) }),
  /** A palette closed with nothing chosen — the search failed, or the list did not help. */
  z.object({ event: z.literal('palette_dismissed'), label: z.enum(PALETTE_DISMISS_VIEWS) }),
  /** A task command got a new shortcut (or lost one) — which defaults people change. */
  z.object({ event: z.literal('shortcut_rebound'), label: taskCommandLabelSchema }),
]);
export type TelemetryEventInput = z.infer<typeof telemetryEventInputSchema>;
