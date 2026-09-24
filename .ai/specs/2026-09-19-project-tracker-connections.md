# Project-bound tracker connections

This connection specification supersedes the server-wide credentials, discovery,
health readiness and onboarding portions of `2026-09-18-jira-linear-tracker-browsing.md`.
Jira/Linear remain read-only; GitHub remains independent. This document and the updated parent
specification form the design-only PR; implementation is delivered separately.

## Behavior

Each canonical local repository owns one credential connection and one selected scope.
Settings → Issue tracker accepts Jira site/email/token or a Linear key, saves locally,
then lets the user browse and connect a vendor project/team. Save does not contact the
vendor; Browse and Connect validate access. Credentials cannot be read back through HTTP.
Missing credentials never fall back to host environment variables or another project.

By default, credentials live outside the checkout under `cezarHomeDir()/tracker-connections/<sha256(canonicalRoot)>.env`,
with `CEZ_HOME` overriding the home directory. Each managed dotenv record has a random UUID, format version, private consistency digest and
a Zod-validated credential variant. Settings writes the file automatically; parsing does not
modify `process.env`. Manual token edits without matching metadata fail closed; re-save through
Settings to rotate the connection safely. Atomic replacement creates a new UUID, invalidating old associations, cursors,
adapter instances and any pending result from the previous connection. POSIX directory
and file modes are 0700/0600; unsafe file permissions, corrupt/missing files and symlink
files fail closed. Writes have no backups and never log secrets. Read-only homes degrade
to unavailable connection state, not failed boot.

The public connection shape is `{id,kind}`; response is `{connection: value|null,demo:boolean}`.
The local non-secret association stores optional `connectionId` for legacy parsing. Real
reads require it to equal the current connection UUID. Association selection must include
that UUID too, preventing an old picker from silently binding to replacement credentials.
Each save is a replacement, including re-entering the same token.

`Disconnect` removes association only. `Remove project credentials` replaces the credential
file with a non-secret disabled marker and removes legacy JSON, preventing delayed migrations
from restoring deleted secrets. A stale association can remain visible for explicit reconnection but cannot read tickets.
Neither action revokes the token at the vendor. Registry removal does not imply deletion of
project state or credentials; remove credentials first when decommissioning a project.
Moving/copying a checkout does not copy its connection. Canonical-path aliases of the same
repository intentionally share a connection.

## API and cache

All tracker endpoints are now project-scoped, including candidates; unscoped URLs alias
the boot project under the repository's route parity convention.

- GET/PUT/DELETE `/api/v1/p/:projectId/tracker/connection`: public status, write-only
  discriminated credential input, offline removal. Invalid input400; write/remove failure409.
- GET `/tracker/candidates`: discovers only with that project's connection.
- PUT `/tracker/association`: validates current connectionId, sourceId and canonical scope.
- Existing association/list/search/detail endpoints retain their payload/error conventions.

Server provider instances are per project+connection+provider and bounded to100 cached
instances. Cached vendor results are not shared between projects, even when source/scope IDs
match. Outer signed cursors bind to project, connection and operation; adapter cursors keep
vendor query/scope binding. A discarded/replaced connection rejects reads before network
and discards results arriving after replacement/removal. Cross-process writes are observed
by reading the private record on each operation; a concurrent write cannot make an old
association valid for a new key. There is no new background polling.

Browser candidate keys include project; list/detail keys and mounted composer identities
also include connectionId. Credential mutations use existing tracker-changed SSE plus
scoped cache cancellation/invalidation. Secret forms are not persisted in browser storage. The token field clears on save, failure,
cancellation and project change; a failed save may retain non-secret origin/email fields. Connection IDs are public
revision identifiers, not authentication tokens.

Legacy health trackerJira/trackerLinear booleans remain for shape compatibility but now
represent demo-only readiness. Real UI readiness comes from the project connection endpoint.
`CEZ_DRY_RUN=1` uses fake credentials-free providers, cannot save/remove real credentials,
and does not read real credential records.

## Migration and security boundary

The [managed dotenv storage specification](2026-09-19-tracker-dotenv-storage.md) defines
serialization and the JSON-to-env migration. Migration preserves the connection UUID, creates
the new file only if absent, validates it, then removes the old JSON. A present invalid env never
falls back to JSON. Migration failure leaves the original recoverable and the connection unavailable.
Removal disables credentials before cleaning up JSON; cleanup failure reports an action error
without reviving the connection. A successful new-format save stays authoritative even if old
JSON cleanup fails. Do not run old JSON-only builds against this store.


Global JIRA_* and LINEAR_API_KEY env values are deliberately ignored. Existing associations
remain visible but require explicit per-project credential setup and reconnection. No silent
import can assign a broad shared key to every project. README/env contract/setup docs explain
this change. Current tickets, prompts, workflow definitions and run history do not migrate.

Storage is permission-protected plaintext, not encryption-at-rest or an OS credential vault.
Encryption/OS-vault support is deferred;
it is not part of current delivery. The filename hash identifies a repository, not encrypted data.
The same OS user (including a broadly permitted agent) can access files. Cezar's project
routing is not tenant authorization; untrusted users require separate OS/process environments
and a suitable authenticated deployment. Tokens should be narrowly scoped at the vendor.
Ticket descriptions still enter local run history and the selected AI backend on launch.
This change does not assert legal/compliance certification or implement retention policies.

## Acceptance

Two real-mode fixture projects with different credentials but identical vendor IDs must
receive only their own results; replayed cross-project/rotated cursors and copied associations
must fail. Deletion/replacement must reject late responses. GET/PUT/error payloads must not
expose token values. Save/reload/remove work without vendor I/O; no global fallback exists.
Demonstrate browser setup, scope selection, project switching, reconnect after rotation,
secret clearing, and removal on an isolated app; report mocked vs live evidence explicitly.
Run full repository gates and maintain Zod/Hono parity and API inventory.
