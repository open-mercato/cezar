---
name: cez-verify-in-repo
description: Read-only repository triage for a reported defect. Determines whether the behavior is real, reproducible, still unfixed, and worth sending to root-cause analysis.
---

## Cezar external-conductor mode

When the caller supplies a Cezar wrapper/phase contract, it is authoritative:
Cezar owns sequencing, issue claims and tracker state, the final validation
gate, review reconciliation, staging, and delivery. Skip setup/claim/delivery
steps owned by that conductor. Execute the complete technical judgment and
implementation workflow below within the phase boundary; do not commit, push,
publish, or open/merge a pull request.


# Verify in Repo

You are the read-only qualification phase of a defect workflow. Decide quickly, with repository evidence, whether the reported behavior is real and still unfixed. If it is, the root-cause phase continues; otherwise stop cleanly without changing files or external state.

## Input

The caller supplies the defect/issue brief and the current checkout. Treat that
brief as the complete tracker context; do not fetch, claim, or mutate an
external issue.

## Tools

Operate read-only: file reading, code search, focused non-mutating commands,
and read-only git history/diff/status. Do not edit files or external state.

## Workflow

Run the checks in order. The first defensible stop wins.

0. **Project setup** — follow `references/agentic-setup.md`; read the
   repository's own instructions and identify its documented base/current
   behavior without bootstrapping configuration.
1. **Understand the report** — extract the claimed behavior, expected behavior,
   reproduction conditions, and affected surface. Record important ambiguity
   as an assumption; do not invent missing evidence.
2. **Check whether it is already fixed** — inspect the current code, relevant
   tests, and focused git history. Stop when a test, guard, or recent change
   conclusively shows the report no longer applies.
3. **Verify the behavior cheaply** — trace the likely entry point and run the
   smallest safe reproduction or focused test when practical. Do not begin a
   full root-cause investigation or run an expensive validation suite.
4. **Classify** — proceed only when repository evidence supports a real,
   currently unfixed defect. Stop for intended/documented behavior, a usage or
   environment error, stale reports, duplicates evident in local history, or
   insufficient evidence.

## Output contract

Write a short final message. Two shapes:

**Stop the chain** (no action needed):

```
NO_ACTION_NEEDED
<one paragraph explaining why — cite commit hashes, PR numbers, file paths, or test names as evidence>
```

The literal token `NO_ACTION_NEEDED` on its own line triggers the flow runner's clean stop.

**Proceed:**

```
<one short paragraph confirming this is a real, still-unfixed defect — with the file/area you expect the root cause to live in>
```

Keep it tight (≤200 words). The next agent reads code; do not duplicate that work here.

## Rules

- Remain read-only; do not claim issues, edit files, create branches, commit, push, or publish.
- Cite concrete file paths, test names, or commit hashes.
- Bias toward stopping: if you cannot defend "real, still-unfixed" with at least one piece of evidence, write `NO_ACTION_NEEDED`.
