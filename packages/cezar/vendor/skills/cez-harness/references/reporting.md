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

Use these matrix symbols:

- `●` — the reviewer raised the finding.
- `—` — the reviewer completed but did not raise it.
- `!` — the reviewer failed, timed out, or returned invalid output.
- `○` — the reviewer was not selected or was skipped during preflight.

Render a reviewer-status table before the findings matrix so `—` cannot be
misread as “the reviewer did not run.” Preserve single-reviewer findings.
The runtime reports its selected advisors. Cezar combines those results with its
runner-backed reviewers and applies the whole-council gate. Under `all-required`,
a selected advisor that remains broken after retries yields no runtime verdict.

The host reconciler may set a finding to `confirmed`, `fixed`, `spurious`,
`waived`, or `unresolved`. Confirm findings against code or runtime evidence;
reviewer agreement is a prioritization signal, not proof by itself.
