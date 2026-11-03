# Review hand-off — authoritative review runs after PR creation

`cez-fix` validates and hands the change to the PR-opening step. The chain performs its single authoritative code-review pass later through `the automated review stage`.

## cez-fix specifics

The later `the automated review stage` pass must apply these checks to a fix produced from an analyzer brief:

- No API response fields removed.
- No data-scoping or permission-check rules weakened; the project's data-access conventions followed in every changed production file.
- Fix remains minimal — edit only what the analyzer named plus tests; refactors belong in their own PR.

Do not run `cez-code-review` directly in `cez-fix`; `the automated review stage` invokes it once after `the delivery step`, driven by `the issue-fix workflow` or the external flow runner.
