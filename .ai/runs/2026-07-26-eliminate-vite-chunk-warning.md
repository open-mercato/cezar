# Eliminate the Vite chunk-size warning

## Goal

Remove the production build's oversized-chunk warning by splitting the stable React runtime out of the cockpit entry bundle without hiding the warning or changing application behavior.

## Scope

- Configure Vite 8's Rolldown code splitting for the React runtime dependencies.
- Add a unit-level contract test for the chunking configuration.
- Verify the production build emits no chunk-size warning and preserves the existing package checks.

## Non-goals

- Do not raise or disable Vite's chunk-size warning threshold.
- Do not redesign route boundaries or alter cockpit navigation behavior.
- Do not broadly repartition every third-party dependency.

## Implementation Plan

### Phase 1: Configure focused runtime splitting

1. Add a named React-runtime code-splitting group to the cockpit Vite configuration.
2. Add a regression test that locks in the focused group and default warning threshold.

### Phase 2: Verify the shipped build

1. Confirm the production bundle stays below Vite's warning threshold and run the full configured validation gate.
2. Review the final diff and document the verified outcome for reviewers.

## Risks

- Manual splitting can affect module execution order; keep the group limited to React's tightly coupled runtime packages and verify through the full unit, build, and packaged-CLI gates.
- Bundle sizes can drift as dependencies change; retaining Vite's default warning threshold ensures future growth remains visible.

## Progress

PR: #692

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Configure focused runtime splitting

- [x] 1.1 Add a named React-runtime code-splitting group to the cockpit Vite configuration. — ba7024ff
- [x] 1.2 Add a regression test that locks in the focused group and default warning threshold. — ba7024ff

### Phase 2: Verify the shipped build

- [x] 2.1 Confirm the production bundle stays below Vite's warning threshold and run the full configured validation gate. — ba7024ff
- [x] 2.2 Review the final diff and document the verified outcome for reviewers. — ba7024ff
