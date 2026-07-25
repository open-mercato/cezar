# Configurable composer run defaults implementation

Source doc: .ai/specs/2026-07-25-configurable-composer-run-defaults.md

## Goal

Make quick-task the cold composer source, expose truthful Worktree controls for eligible workflow shapes, and add tolerant workspace/environment policy for Autonomous and Worktree defaults.

## Scope

- Add optional workspace composer defaults with exact environment inheritance and additive workspace API contracts.
- Add Global Resources controls and a shared composer resolver.
- Replace last-choice resolution with policy, select quick-task cold, and support eligible single-step workflow Worktree choices.
- Document the two new environment variables.

## Non-goals

- Interactive skill metadata is implemented independently by its companion PR.
- Multi-step or parallel runs remain isolated; runner and run request contracts are unchanged.

## Risks

- Workspace config must remain optional, passthrough, per-entry tolerant, atomic, and non-blocking.
- Worktree-off exposes the current checkout, so eligibility and forced-state explanations must remain truthful.
- Cold quick-task selection must never override drafts, deep links, or explicit source memory.

## Progress

PR: #666

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Workspace policy

- [x] 1.1 Add tolerant composer defaults and effective helpers — 3e2002ce
- [x] 1.2 Extend workspace GET and PUT contracts — 3e2002ce
- [x] 1.3 Extend web types and shared resolver — 3e2002ce
- [x] 1.4 Add Global Resources controls — 3e2002ce

### Phase 2: Composer behavior

- [x] 2.1 Stop reading and writing legacy last-choice keys — 3e2002ce
- [x] 2.2 Make quick-task the cold default — 3e2002ce
- [x] 2.3 Support single-step workflow Worktree eligibility — 3e2002ce

### Phase 3: Contract and verification

- [x] 3.1 Document environment variables and update drift coverage — 3e2002ce
- [x] 3.2 Run the full validation gate and browser smoke flows — validation passed; browser evidence follows on the PR
