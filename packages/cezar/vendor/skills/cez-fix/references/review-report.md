# Review and report — self-review of the fix

Detailed procedure for the self-review step of `cez-fix`.

## Self-review

Use the `cez-code-review` skill against the change plus a breaking-change review. Explicitly verify:

- No public contract was broken silently: exported APIs, HTTP routes and response shapes, event names, CLI flags, DB schema, config formats. When `BACKWARD_COMPATIBILITY.md` exists at the repo root, check the change against its protected surfaces; honor any other compatibility rules the project documents. A violation without the documented migration/deprecation path must be fixed or, when intentional, explicitly WARNED about in the final summary so the user decides.
- No security-sensitive surface was weakened: authentication, authorization, data scoping, input validation, secrets handling.
- Scope remains what the analyzer's brief says — no unrelated churn.

If self-review finds issues, fix them and re-run the validation loop.

## cez-fix specifics

Additional checks for a fix produced from an analyzer brief:

- No API response fields removed.
- No data-scoping or permission-check rules weakened; the project's data-access conventions followed in every changed production file.
- Fix remains minimal — edit only what the analyzer named plus tests; refactors belong in their own PR.

The automated second review pass (`the automated review stage` in autofix mode) is **not** part of this step — it runs later in the chain, after `the delivery step`, driven by `the issue-fix workflow` or the external flow runner.
