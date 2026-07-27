# Review report output format

The report skeleton `cez-code-review` produces at workflow step 8. Callers
(`om-auto-review-pr`, `om-review-prs`, the self-review steps of
`om-auto-create-pr` / `om-auto-continue-pr`) consume the verdict and the
blocker/major findings from this structure.

Use this structure for every review:

```markdown
# Code Review: {PR title or change description}

## Summary
{1-3 sentences: what the change does, overall assessment}

## Verdict
{approve | request changes} — {one-line justification}

## Validation Gate

| Command | Status | Notes |
|---------|--------|-------|
| {validation.commands[0]} | PASS/FAIL | |
| {validation.commands[1]} | PASS/FAIL | |
| {…one row per configured command, in order} | | |

## Findings

### Blocker
{Must fix before merge — security, data integrity, data scoping, contract breaks, failing gates}

### Major
{Correctness bugs, architecture violations, missing regression tests, weakened assertions}

### Minor
{Convention violations, suboptimal patterns, readability}

### Nit
{Style suggestions, optional polish}

## Breaking Changes
- [ ] No exported/public symbol removed or renamed without a deprecation path
- [ ] No function signature changed in a breaking way (required params removed or reordered, return type changed)
- [ ] No required type field removed or narrowed
- [ ] No HTTP route URL removed or renamed; no method changed for an existing operation
- [ ] No field removed or retyped in an existing response shape
- [ ] No event or message name renamed or removed; no payload field removed
- [ ] No CLI command or flag renamed or removed; no machine-parsed output format changed
- [ ] No database table or column renamed or removed; no column type narrowed
- [ ] No config key renamed and no default changed silently
- [ ] Where a contract had to change: old surface kept working through a deprecation window, with migration notes

## Test Coverage
{covered | gaps, with the exact test cases to add}
```

Omit empty severity sections. Mark passing checklist items with `[x]` and failing with `[ ]` plus an explanation.
