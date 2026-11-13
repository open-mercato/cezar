# Extensions

Settings → Extensions installs trusted npm packages or built local folders globally. Choose
the project in that screen, review the exact artifact and requested access, then enable it.
The catalog labels registry packages **Public extension** and folder installs **Local extension**.
Installation alone never grants project access. Local folders have Reload; npm updates resolve
the original requested package/range again. Preview and install use the same immutable snapshot.

Extension API `0.1` supports commands, declarative panels and forms/settings, and informational
task events. Task proposals open the normal editable new-task form; they never start a run. There
is no tracker or runner extension API.

Each enabled extension/project pair has its own Node worker. This contains failures, **not
malicious code**: extensions run as your OS user and can access files and the network. Only
install code you trust. Official host APIs fix project identity, check declared permissions,
encrypt extension secrets and redact known secret values from logs and worker results/errors.

Disable fences host mutations, removes contributions and stops the worker. A worker that dies
after activation restarts with backoff (1 s, 2 s, 4 s); after three rapid crashes, or a failed
activation, it is shown as Failed — review and retry explicitly. Approved enabled workers restore when
the project opens after a cockpit restart. Updates stop affected workers, snapshot extension
data and owned secrets, and restore the previous version after failed activation. Additional
permissions/capabilities require project approval again. External platform effects cannot be
rolled back; activation must not perform migrations with external side effects.

Uninstall stops the extension in open projects and removes its global installation record.
Data is kept by default: each project that had approved the extension keeps that approval,
disabled, so the extension stays listed there as **Missing** with no actions until it is
reinstalled. The explicit delete-data choice removes extension-owned data/secrets and the
Missing entry from registered projects. Shared task history is retained. Reinstall requires
approval again. Unrelated extensions keep their approvals.

Extensions are on by default on a local cockpit. `CEZ_EXTENSIONS=0` turns them off: no worker is
restored or started, and installing, updating, uninstalling, enabling or invoking answers 409;
installed files and approvals stay on disk. A hosted cockpit always refuses to install or run
extensions.

Examples:

- [Project summary](../examples/extensions/project-summary): task snapshot, live updates and refresh.

The SDK is `@open-mercato/cezar-extension-sdk`, API line `0.1`. See
[authoring extensions](authoring-extensions.md). `npm run test:pack -w
@open-mercato/cezar-extension-sdk` builds the example outside this workspace against the packed
SDK.

HTTP installation operations live under `/api/v1/extensions`: list, `prepare-install`,
`commit-install`, `:extensionId/prepare-update`, `:extensionId/uninstall-impact` and DELETE
`:extensionId` (optional `removeData=true`). Project access lives under
`/api/v1/p/:projectId/extensions/access`; enable/disable, commands, forms and panels use that
project's `extensions/:extensionId` family, and `extensions/placements` lists contributions per
location. Enable requires the reviewed artifact's `integrity`. Project routes are also mounted
for the boot project without the `/p/:projectId` prefix.

Direct tarball installation through the cockpit is unsupported: use a built folder with runtime
dependencies or an available npm package version.
