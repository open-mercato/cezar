# Managed project dotenv credential storage

This specification defines the temporary managed dotenv storage used by
[project-bound tracker connections](2026-09-19-project-tracker-connections.md).
It preserves the existing credential form and per-project isolation. Encryption and OS-vault
integration are deferred. This PR contains design documents only.

Keep project Settings credential forms and existing write-only HTTP shapes. Store one managed
`cezarHomeDir()/tracker-connections/<sha256(canonicalRoot)>.env` per canonical project root,
using the existing CEZ_HOME override. No general repository dotenv loading, process.env mutation,
agent forwarding, global fallback or provider changes. File values use provider names JIRA_BASE_URL,
JIRA_EMAIL, JIRA_API_TOKEN or LINEAR_API_KEY. Add RECORD_VERSION, CONNECTION_ID and CREDENTIAL_SHA256
metadata; the digest checks consistency after manual edits, not malicious tampering or encryption.

Parse with dotenv.parse, never config/source/eval. Use direct service dependency compatible with
Node >=20. Serialize literals with round-trip validation; reject control characters, ambiguous
unsupported quoting, duplicate/unknown keys and unsupported format versions. Failed encoding leaves
previous credentials unchanged. Editing a token without updating metadata disables the connection;
replace through the existing form to establish a fresh UUID. No manual reload button is required.
The form discloses plaintext local storage. No encryption or OS vault in this change.

Preserve POSIX0700/0600, bounded reads, safe file checks and atomic writes. Windows permissions
remain subject to existing filesystem/ACL limitations; do not claim POSIX equivalence. No backups.

Migrate legacy JSON on first read only when the env path is absent. Atomically create-if-absent
via hard link of a fully written private temporary file; never overwrite a competing env save or
removal. Re-read and validate authoritative env, then unlink JSON. Preserve UUID during conversion.
On unsupported filesystem/migration failure, leave JSON recoverable and return unavailable. A
present invalid/symlink/unsafe env must not trigger JSON fallback. A new-format save is authoritative;
legacy cleanup is best-effort after save and does not roll back a successful credential replacement.

Credential removal atomically replaces the file with only RECORD_VERSION=1 and
CONNECTION_DISABLED=true, then removes legacy JSON. This non-secret tombstone is intentionally
retained: a late migration cannot resurrect deleted credentials. No vendor revocation is implied.
A cleanup failure returns an action failure with credentials already disabled. Old JSON-only
processes cannot consume the new format; do not run a mixed-version deployment or promise rollback.

Verify literal round trips, isolation, revisions, migration races, corruption, file permissions,
symlinks, atomic replacement failure, bounded input, manual edits and stale provider/result rejection.
Run repository gates and browser credential save/connect/replace/remove with mocked vendor transport;
record clearly that these checks are not live vendor acceptance.
