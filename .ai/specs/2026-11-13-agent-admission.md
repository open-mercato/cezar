# Trusted before-agent admission

## Problem

Worktree lifecycle setup runs only when a worktree is created or re-created. It
cannot enforce policy that must be rechecked before every agent session, notably
after Continue, restart recovery, scheduler launch, or dispatch. An external
coordinator must not solve that by moving execution into a second worktree:
Cezar's Changes, Commits, autosave, resume, retention, and cleanup all read the
native task workspace.

## Contract

An optional `agentAdmission.beforeAgent` script entry in the project-local,
untracked `.ai/cezar/config.json` runs immediately before every agent session.
It uses the same bounded process supervision and local-trust rule as worktree
lifecycle scripts. A tracked command is never executed.

The command runs with the native task workspace as `cwd` and receives a
versioned JSON object in `CEZ_AGENT_ADMISSION_CONTEXT`. The object identifies
the project, run, issue/PR references, automation provenance, dispatch lineage,
native workspace/branch/base, and the launch kind, step, runner, and resumed
session when applicable.

The command must exit successfully and print exactly one JSON line:

```json
{"decision":"allow","handle":"optional external ownership handle"}
```

or:

```json
{"decision":"deny","reason":"actionable reason"}
```

Missing configuration is the unchanged zero-config path. Invalid config,
command failure, ambiguous output, malformed JSON, or a denial fails closed
before the runner starts. Initial workflow sessions and all continuation paths
call the same admission function.

## Ownership boundary

Admission deliberately does not create, change, or remove a worktree and does
not duplicate external governance state. The external coordinator owns its
claim and its verified release rules. A Cezar task reaching `done`, `review`,
`failed`, or `waiting` is not proof that such a claim may be released; retries,
review, resume, and interrupted work all remain possible. Consequently release
is not coupled to agent-session settlement or worktree retention.
