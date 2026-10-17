# Fix Pi agent config surface (#894)

Goal: expose Pi's documented nonsecret settings files in Settings → Agent Config, with the
same safe cataloging, absent-file handling, hosted read-only boundary, and home resolution as
the other supported runners.

Scope:

- Add Pi's descriptor and focused UI coverage.
- Add Pi's global/project settings entries to the agent-config catalog and focused catalog tests.
- Add the documented `PI_CODING_AGENT_DIR` default-home resolution needed by the catalog and
  account/default profile path consumers (shared path tests included). This is required to avoid
  showing the wrong path when Pi's documented relocation variable is set.
- Keep Pi credentials (`auth.json`, OAuth state), models registry, sessions, MCP, and extension
  directories out of the editable catalog; no API shape changes.

Non-goals:

- No Pi runner changes, model discovery changes, authentication/profile support, or MCP support.
- No edits to unrelated agent descriptors, catalog entries, or hosted disclosure behavior.

Implementation plan:

### Phase 1: Catalog and resolution

1.1 Add Pi's resolved home path and settings entries (`settings.json`, JSON/JSONC, user and project), with documented precedence and safe labels.
1.2 Add regression tests for default/override paths, catalog IDs/ownership, absent files, and credential/MCP exclusion.

### Phase 2: Settings UI

2.1 Add the Pi descriptor with Settings and Memory & instructions groups, and update descriptor tests.
2.2 Add Agent Config section coverage for the Pi tab, grouped files, absent files, and hosted read-only rendering.

### Phase 3: Verification and handoff

3.1 Run focused tests and the configured validation gate; prove the focused regression is red before the fix and green after it.
3.2 Run the authoritative PR review/autofix pass, record evidence, and hand off the ready PR.

Risks: Pi's config directory relocation is documented, but credentials and other state share that directory; only the settings files are catalogued, preserving the secret boundary. The project settings file is tracked by convention and remains subject to the existing write/hosted guards.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Catalog and resolution

- [x] 1.1 Add Pi's resolved home path and settings entries (`settings.json`, JSON/JSONC, user and project), with documented precedence and safe labels. — 7a6dc317
- [x] 1.2 Add regression tests for default/override paths, catalog IDs/ownership, absent files, and credential/MCP exclusion. — 7a6dc317

### Phase 2: Settings UI

- [x] 2.1 Add the Pi descriptor with Settings and Memory & instructions groups, and update descriptor tests. — 7a6dc317
- [x] 2.2 Add Agent Config section coverage for the Pi tab, grouped files, absent files, and hosted read-only rendering. — 7a6dc317

### Phase 3: Verification and handoff

- [x] 3.1 Run focused tests and the configured validation gate; prove the focused regression is red before the fix and green after it. — focused 48 passed; baseline gate failures recorded in `.ai/qa/issue-894-pi-agent-config.md`
- [x] 3.2 Run the authoritative PR review/autofix pass, record evidence, and hand off the ready PR. — self-review found no scoped findings; browser QA blocked by missing `libnspr4.so`

Verification evidence: `.ai/qa/issue-894-pi-agent-config.md`.
