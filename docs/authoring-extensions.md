# Authoring an extension

Create a separate ESM package with `@open-mercato/cezar-extension-sdk` as its only Cezar
dependency. Build before installing a local folder; a plain `npm install` is fine, the
`node_modules/.bin` command links it creates are left out of the installed copy (any other
symbolic link is refused). Never import Cezar's private contract,
API client, server or React components. The SDK tarball includes its own runtime and types.

Add `cezar-extension.json` with `id`, `name`, exact `version`, `apiVersion: "0.1"`, `entry`,
`capabilities`, `permissions` and `contributes`. See the [example](../examples/extensions/project-summary).
`capabilities` is required; list what the extension contributes and use `[]` if it contributes
nothing. Unknown capabilities and permissions fail validation. Supported capabilities are
`commands`, `panels`, `taskEvents`, `forms`, `settings`, and `chatProviders`. Capabilities are
declarations shown on the consent card; `permissions` are the boundary the host enforces. The SDK
already defines the chat adapter interface (`contributes.chatProviders`, `context.chat`), but this
host does not run chat providers yet.

Export `defineExtension({ activate(context) { … } })`. Return a disposable which releases
subscriptions and resources. Register only declared contribution IDs:

```ts
context.commands.register('refresh', async () => ({ message: 'Refreshed' }))
context.panels.register('summary', async () => ({
  id: 'summary', title: 'Summary',
  blocks: [{ type: 'text', text: 'Plain text only' }],
  actions: [{ id: 'refresh', label: 'Refresh' }],
}))
```

The permissions are `project.read` and `task.create`; each gates a host API below.
`tasks.list()` needs `project.read` and returns the 500 newest
tasks. `tasks.propose({title,prompt,
workflow?})` needs `task.create`; its receipt always has `accepted: false`. Proposals returned
by a command are offered as links to the normal new-task confirmation form. No direct launch
API is available. Task events are informational, bounded and may emit `resyncRequired`; reload
the snapshot after that signal. They are not an automation delivery queue.

`storage.get/set` accept JSON keys/values in this extension/project namespace, at most 1000
keys and 4 MiB in total; a `set` past either limit rejects and keeps the stored values.
Stdout carries the host's IPC, so `console.*` and anything your code or a dependency writes to
`process.stdout` goes to stderr instead. The host prints the end of stderr if the worker crashes.
`secrets.get/set` use Cezar's encrypted project secret store. Do not put secrets in storage, output,
exception messages or environment variables. Known values are redacted, but the host cannot
recognize arbitrary encodings of a secret. `logger.info/error` are redacted too.

Declare forms under `contributes.forms`, with `id`, `title`, `commandId` and `fields`.
Fields have a `key`, `label`, `type` (`text`, `password`, `number`, `boolean`, `select`),
optional `required`, and `options` for selects. Register an optional dynamic provider with
`context.forms.register`; it may return saved `values`. Password defaults are withheld.
Submission validates the manifest's fields before invoking the declared command; save settings
through storage/secrets from that handler. No executable validator, HTML or React crosses IPC.

Direct cockpit tarball installation is unsupported; use a built folder with runtime dependencies
or an available npm package version.

RPC limits: activation 10 seconds, shutdown 5 seconds, ordinary calls 30 seconds, frames 1 MiB,
100 pending calls. A worker receives minimal environment and cannot select its host project.
Every request is generation-fenced.

Registry installs are resolved by cezar itself, not by `npm install`: npm only supplies your
`registry` and `@scope:registry` settings, and a scoped package is fetched only from its scope's
registry. Proxies, auth tokens and git/URL/file dependencies are not supported, so private
registries that need a token are unavailable. Dependencies requiring install scripts and
symlinked artifacts are rejected. Packages flagged `hasInstallScript` (including a `binding.gyp`-only
native build) are refused, and so is any scope whose registry URL embeds credentials — use a URL
without them; that scope is never fetched from the default registry. Updates are explicit. Keep activation idempotent,
and limit migrations to local extension-owned state so rollback can restore it.

Task proposals must be awaited inside a command invocation. Each invocation returns only its own proposals; a failed command discards them. Calls from activation, task events or work continuing after the command returns are rejected. The user still reviews the normal new-task form before launching anything.

## Where contributions appear

By default every panel and command renders in Settings → Extensions. An optional `location`
on a declared panel or command moves it to where the user works:

```json
"contributes": {
  "panels":   [{ "id": "summary", "title": "Project summary", "location": "sidebar" },
               { "id": "task-notes", "title": "Notes", "location": "task" }],
  "commands": [{ "id": "refresh", "label": "Refresh summary", "location": "palette" },
               { "id": "summarize", "label": "Summarize this task", "location": "task" }]
}
```

- Panel locations: `settings` (default), `sidebar` (a collapsible section under the sidebar
  project's areas, above Current tasks) and `task` (a card in the task workspace's **Extensions** view). Command locations:
  `settings` (default), `palette` (the command palette, shown as "<Extension name>: <label>")
  and `task` (a button in that same view). A panel's action buttons have no `location`; they
  run the declared command where the panel is.
- Limits per extension: 3 `sidebar` panels, 5 `task` panels, 20 `palette` commands.
- A `task`-located panel provider receives `{ runId }` and a `task`-located command receives it
  as `input.runId`; both are asserted by the host for the task the user is looking at. Load the
  task with `context.tasks.get(runId)` (needs `project.read`; returns `null` when the run is not
  in this project — it is the same shape as one `tasks.list()` item). Sidebar, palette and
  Settings calls pass no task.
- Panels are pulled, never pushed: the cockpit calls your provider when it shows the panel,
  after one of its actions runs, and when the extension's state changes. A `task` panel is also
  re-read when that task's status or step changes, and a `sidebar` panel when any task in the
  project starts or changes status (both about a second after the change settles). A worker
  cannot ask for a refresh, so render what is true at call time.
- Everything else is the same declarative renderer, the same permissions and the same
  worker. Nothing here grants new trust, and a hosted cockpit shows none of these surfaces.

The [project-summary example](../examples/extensions/project-summary) uses every placement
(its `test/` drives each one through a fake host), and the snippets above are checked against
the SDK types by that example's build.

## Versioning

`apiVersion` is the compatibility contract between an extension and the host, separate from
the npm versions of the SDK or your package. The SDK exports the accepted list as
`EXTENSION_API_VERSIONS` and the current value as `EXTENSION_API_VERSION`; today both are
`0.1`.

- The API stays at `0.1` until 1.0. Changes inside `0.1` are additive: new optional manifest
  fields, new capabilities or context methods. Existing manifests and adapters keep working.
- A breaking change gets a new `apiVersion`. A host lists every version it still runs, so a
  release can accept both the old and the new value for a transition period.
- The SDK package is released in lockstep with cezar, so its npm version follows cezar's.
  Depend on it with `>=0.1.0 <1.0.0` (as the examples do); the `apiVersion` you declare,
  not the SDK version, decides whether a host accepts your extension.
- A host that does not support a manifest's `apiVersion` rejects the install with a
  validation error. A stored record with an unsupported `apiVersion` (for example after
  downgrading cezar) is unreadable: it is shown as Failed, never started, and kept in the
  registry until a reinstall replaces it. Reinstall the extension from its source after
  upgrading again; its storage and secrets are kept unless you uninstalled with data removal.
- Uninstalling and keeping data leaves the extension listed as **Missing**, without actions, in
  every project that had approved it; uninstalling with data removal also drops that entry.
  Reinstalling brings it back disabled, pending approval.
