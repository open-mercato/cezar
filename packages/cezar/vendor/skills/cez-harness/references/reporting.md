# Review reporting and reconciliation

This contract is loaded when a multi-model pass completes.

The JSON artifact is authoritative. Each reviewer record carries its id, model
family, requested model, observed actual model when available, provider,
provenance status, fallback reason, role, fresh-context attestation, review
contract hashes, status, and duration. Unobserved
command-adapter provenance is shown as unverified, never inferred. Each finding
carries a stable fingerprint, severity, category, title,
location, evidence, impact, remediation, confidence, reporting reviewers, and
resolution.
The top-level verdict follows `cez-code-review` mechanically: any blocker or
unwaived major from a completed reviewer yields `request_changes`; only minor,
nit, or no findings yields `approve`. Keep provider readiness policy separate
from this review verdict.

High-assurance packet artifacts add a packet ledger, immutable review-cycle
JSON/Markdown files, path leases, invocation budgets, and a SHA-256 identity for
the reviewed diff. Candidate findings carry `verification.status` of `verified`
or `rejected` and the verifier ids. Only verified findings may enter the fixer
prompt. The final gate artifact records which trusted command or manual method
covered each acceptance criterion for that exact diff.

Use these matrix symbols:

- `●` — the reviewer raised the finding.
- `—` — the reviewer completed but did not raise it.
- `!` — the reviewer failed, timed out, or returned invalid output.
- `○` — the reviewer was not selected or was skipped during preflight.
- `◐` — the reviewer shares the implementation worker's model family and is a
  self-check rather than independent confirmation.

Render a reviewer-status table before the findings matrix so `—` cannot be
misread as “the reviewer did not run.” Preserve single-reviewer findings.
The bound wrapper report lists fresh Claude first, followed by every configured
advisor. A missing or invalid Claude artifact blocks the council rather than
appearing as a skip. The provider review policy counts only configured profile
reviewers; under `all-required`, a reviewer that stays broken after its
retries blocks the council with no verdict.

The host reconciler may set a finding to `confirmed`, `fixed`, `spurious`,
`waived`, or `unresolved`. Confirm findings against code or runtime evidence;
reviewer agreement is a prioritization signal, not proof by itself.
