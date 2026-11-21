# Cezar harness runtime

Cezar-owned source, descended from `open-mercato/skills` and maintained here.
The cezar phase driver owns orchestration. This directory supplies deterministic
Git operations, structured reviewer adapters and their contracts; it does not
launch implementation workers or choose a run's lineup.

- [`SKILL.md`](SKILL.md) describes the runtime commands.
- [`scripts/harness.mjs`](scripts/harness.mjs) executes them without a shell.
- [`references/configuration.md`](references/configuration.md) defines reviewer bindings and council policy.
- [`references/adapter-contract.md`](references/adapter-contract.md) defines command, HTTP and preset adapters.
- [`references/code-review-contract.md`](references/code-review-contract.md) binds reviews to one subject and rubric.
- [`references/reporting.md`](references/reporting.md) describes the result artifacts.
- [`references/stage-only-contract.md`](references/stage-only-contract.md) defines the staged handoff.

`cez-setup-harness` helps users connect providers and add advisor bindings. Ordinary
Claude/Codex seats and supported OpenCode gateway models use the cockpit's lineup
and existing provider logins. Runtime profiles group advisor reviewers for a single
invocation; they do not configure cezar's orchestrator or implementer.

The conductor seals this tree and its companion skills outside the task worktree
and checks its digest before each operation. Agent sandboxing lives in cezar's
runner integration, not in optional repository hook files. Capture/verify/stage
add Git-integrity checks; publication remains a separate user action.

When changing the runtime, run its harness tests and the installed-package gate.
Do not regenerate this directory from upstream: it is listed in `cezarOwned` in
the vendor manifest. Only the five generic phase skills are generated.
