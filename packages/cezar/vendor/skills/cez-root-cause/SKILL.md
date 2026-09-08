---
name: cez-root-cause
description: Read-only root-cause analysis for a reported defect. Identifies the failure mechanism and minimal change surface so implementation can proceed without re-exploring the repository.
---

## Cezar external-conductor mode

When the caller supplies a Cezar wrapper/phase contract, it is authoritative:
Cezar owns sequencing, issue claims and tracker state, the final validation
gate, review reconciliation, staging, and delivery. Skip setup/claim/delivery
steps owned by that conductor. Execute the complete technical judgment and
implementation workflow below within the phase boundary; do not commit, push,
publish, or open/merge a pull request.


# Root Cause

You are step 2 of an autofix chain (`cez-verify-in-repo` → `cez-root-cause` → `cez-fix` → `the delivery step` → `the automated review stage`). The chain is driven end-to-end by the `the issue-fix workflow` skill, or by an external flow runner. The previous step (`cez-verify-in-repo`) already confirmed this is a real defect. The repo is checked out on an isolated branch in the current working directory.

Your only job: find the root cause and define the minimal change set. The next step (`cez-fix`) implements what you propose — keep that agent on rails by being specific.

## Input and tools

The caller supplies the complete defect brief and qualification evidence.
Operate read-only: inspect files, search code, run focused reproductions, and
use read-only git history/diff/status. Do not fetch tracker state, edit files,
commit, push, or publish.

## Workflow

0. **Project setup** — follow `references/agentic-setup.md`; use the repository and phase context supplied by the caller. Missing optional config degrades to discovery and never triggers another setup workflow.

1. **Re-read the supplied defect evidence.** Extract reproduction steps, expected/actual behavior, constraints, and any cited files or commits. The phase prompt is the authoritative issue context.

2. **Read just enough project context.** Read the repository's agent instructions and contributing docs (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, or equivalents) for the affected area. If the repo keeps design docs, architecture notes, or lessons files related to the affected area, skim them. Stop reading project context as soon as you can name the file(s) involved — do not pre-emptively read the whole codebase.

3. **Locate the bug.** Trace the code path that produces the reported behavior. Search the codebase to find the entry point (route, handler, exported function, test), then read enough surrounding code to understand the flow. Watch for departures from the project's own conventions in the area — for example, code that bypasses the data-access, validation, or security helpers the surrounding code routes through. A bug is often exactly such a departure from the local pattern. If reproduction is cheap (a single failing test or a quick command), confirm the bug exists. Do not run expensive validation suites — that is the `cez-fix` step's job.

4. **Decide the minimal change.** Pick the smallest module/function that owns the bug. Do not propose refactors. Do not broaden scope "while you're here." Preserve existing contracts unless the issue explicitly requires a contract change.

5. **Report.** Write a final message in this shape (plain text, no JSON):

   ```
   Summary: <one-sentence description of the bug>

   Root cause: <one paragraph — where in the code, why it produces the wrong behavior>

   Files to change:
   - <path/to/file-a.ts> — <what changes here>
   - <path/to/file-b.ts> — <what changes here>
   - <path/to/file-a.test.ts> — <regression test to add>

   Approach: <2–4 sentences describing the minimal edit. Reference function names, conditions, and the specific behavior change. Mention any constraint from the project's agent instructions or design docs the fix must respect.>

   Risks: <one short paragraph — what could go wrong, what to validate, breaking-change concerns>
   ```

   Keep it under ~400 words. The `cez-fix` agent reads this verbatim and acts on it.

## Rules

- Read-only on files and git state — never edit, commit, or push.
- Do not propose changes to multiple unrelated areas; if the issue spans concerns, pick the smallest defensible primary fix and note the rest under Risks.
- Reference real file paths and function names — vague guidance forces the `cez-fix` agent to re-explore and burns its budget.
- If you cannot locate a confident root cause, end with `LOW_CONFIDENCE` and your best-guess analysis; the chain will continue but a human reviewer will need to check the fix more carefully.
