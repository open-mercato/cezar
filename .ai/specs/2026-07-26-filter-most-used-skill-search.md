# Filter Most-Used Skills in Every Picker

## TLDR

All grouped skill pickers must apply the same search pipeline: rank and filter the complete skill catalog first, then partition only the matches into Most used, Project, and Global tiers. This fixes unrelated frequently used skills remaining visible during a search while preserving the established frequency/locality ordering for an empty query.

## Problem Statement

The cockpit has three grouped skill-selection controls, but they do not share one complete search contract. New Task and GitHub hand-off explicitly call `searchSkills` before `partitionSkillsForDisplay`; Prompt Templates partitions the complete catalog and relies on cmdk's group-local filtering. That split permits the Most used tier to retain unrelated entries and makes equivalent controls regress independently.

The visible contract is that a query filters every tier from the same catalog. A matching frequently used skill should remain in Most used, non-matching frequently used skills should disappear, and matching entries should retain established match-quality, usage, and locality ordering. With no query, the #519 ordering and five-entry Most used cap must remain unchanged.

## Proposed Solution

Add a shared grouped-picker helper in `web/app/src/lib/skills.ts` that composes the existing primitives in the required order:

1. `searchSkills(skills, query, usage)` filters and match-ranks the full catalog.
2. `partitionSkillsForDisplay(matches, usage)` partitions only those matches into Most used, Project, and Global tiers.

Migrate New Task, GitHub hand-off, and Prompt Templates to this helper and controlled query state. Set cmdk filtering off for these pickers so application state is the sole source of filtering and ordering truth. Keep workflow searching in the New Task mixed picker unchanged, using the same controlled query.

The alternative—repairing Prompt Templates alone—would leave duplicate composition logic across all three controls and preserve the regression surface. Changing `partitionSkillsForDisplay` to accept a query would mix search semantics into a tiering primitive used by non-search surfaces, so a small composing helper is the narrower contract.

## Architecture

The change stays within the cockpit UI:

- `web/app/src/lib/skills.ts` owns the shared grouped search-and-tier contract and continues to reuse `searchSkills` and `partitionSkillsForDisplay`.
- `SourcePill`, GitHub `SkillsPicker`, and `TemplateSkillsPicker` consume the returned `SkillTiers` and render only those arrays.
- Each picker owns controlled `search` state, clears it when the popover closes, and uses `<Command shouldFilter={false}>` so cmdk does not apply a second, group-local filter or reorder.

No server endpoint, event, persistence schema, skill discovery rule, or public package surface changes. Existing `skillUsage` state remains additive and unchanged.

## Data Model

No data-model or migration changes. The helper accepts the existing read-only skill catalog, query string, and optional `skillUsage` map and returns the existing `SkillTiers` shape.

## API Contracts

No HTTP or agent protocol changes. The new TypeScript helper is an internal cockpit utility with this semantic contract:

- Empty/whitespace query: preserve existing Most used → Project → Global tier membership and ordering.
- Non-empty query: omit every non-match before tiering; rank matches with current `searchSkills` semantics; promote only matching used skills into Most used.
- No matches: return three empty arrays.

## UI/UX

All three picker surfaces retain their current layout, headings, selection behavior, keyboard navigation, and accessibility labels. Typing a query immediately removes unrelated options from every visible tier. A matching high-usage skill remains under Most used; a matching unused skill remains under its Project or Global tier. Clearing the query restores the full #519 ordering.

No visual redesign or new state is introduced, so static mockups are unnecessary. Browser QA should exercise the current components directly.

## Edge Cases & Failure Scenarios

- A frequently used skill that does not match must not survive merely because it was promoted before filtering.
- A frequently used skill that does match must remain eligible for Most used and preserve usage ordering among comparable matches.
- Shadowed skills with distinct paths continue to render as distinct command values; search and tiering remain name/description based as today.
- Whitespace-only queries behave as empty queries.
- Closing and reopening a picker clears its query and restores the full ordered catalog.
- New Task's workflows continue to participate in the mixed picker search without changing skill tier semantics.

## Risks & Impact Review

The blast radius is limited to one shared UI helper and three consumers. The primary regression risk is accidental empty-query reordering or double filtering through cmdk. Unit and interaction tests pin both behaviors, while real-browser QA verifies grouped rendering and keyboard-driven search. Rollback is a straightforward revert because no persisted state or external contract changes.

Compatibility impact is none: the protected API, NDJSON, workflow YAML, skill Markdown, and ui-state shapes are untouched.

## Phasing

### Phase 1: Establish and adopt the shared contract

Introduce the grouped helper, migrate all three pickers, and add focused unit and interaction coverage in one independently shippable change.

### Phase 2: Verify user-facing behavior

Run the repository validation gate and exercise the affected picker flows in the real browser, retaining `needs-qa` for the pipeline's human QA gate.

## Implementation Plan

### Phase 1: Shared grouped search contract

1. Add a helper in `web/app/src/lib/skills.ts` that calls `searchSkills` over the full catalog and partitions only its result; add `skills.test.ts` cases for matching and non-matching high-usage entries, empty queries, and no-match queries.
2. Update New Task `SourcePill` and GitHub `SkillsPicker` to consume the helper without behavior or layout changes; add interaction tests proving searches filter every rendered tier and clearing search restores current ordering.
3. Update Prompt Templates `TemplateSkillsPicker` to controlled query state, the shared helper, and `shouldFilter={false}`; add interaction coverage equivalent to the other two pickers.

### Phase 2: Verification

4. Run typecheck and focused cockpit unit tests, then the full configured validation sequence.
5. Run the UI smoke suite and capture evidence that unrelated Most used entries disappear in each affected picker while matching entries remain correctly tiered.
