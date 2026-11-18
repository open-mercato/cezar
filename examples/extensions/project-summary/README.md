# Project summary extension

The worked example for extension placements: one extension, one worker, contributions in
every place the cockpit offers (`location` in `cezar-extension.json`).

| Contribution | `location` | What it shows |
| --- | --- | --- |
| panel `summary` | Settings (default) | a table of up to 100 tasks with a **Refresh summary** action |
| panel `counts` | `sidebar` | Open / Running / Waiting counts, as a collapsible section under the project nav |
| panel `task` | `task` | the current task's title, status and lifecycle, as a card in the task's **Extensions** view |
| command `refresh` | `palette` | **Project summary: Refresh summary** in the command palette; the Settings panel's button runs it too |
| command `follow-up` | `task` | **Propose follow-up** in the Extensions view header: proposes a task titled after the current one |

Every panel reads one snapshot from `tasks.list()`; the refresh command and task events reload it.
The task panel and the task command receive the host-asserted `runId` and load the task with
`tasks.get(runId)`; outside a task they say so instead of failing. `tasks.get` carries no
timestamps, so the lifecycle line (not started / started / finished) is derived from the status.
The follow-up is a proposal: it opens the normal new-task form and launches nothing. Disabling
disposes all six registrations.

Install the public SDK dependency with `npm install`, then `npm run build`. `npm test` builds and
drives the extension through a fake host (`test/`). Install this directory in Cezar and enable it
for a project, granting task read access and task proposals (`project.read`, `task.create`).

To build against a local SDK checkout instead of the npm release, install its tarball:
run `npm pack` in `packages/extension-sdk`, then `npm install /absolute/path/to/the.tgz`
in a copy of this example. The SDK's `test:pack` automates this standalone check and runs
the tests above against the packed SDK.
