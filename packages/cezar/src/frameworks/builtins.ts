import { OPEN_MERCATO_SDD_INSTALL, OPENSPEC, SPEC_KIT } from './vendor-catalog.ts';

/**
 * Built-in frameworks (spec 2026-11-15-framework-board § Built-in frameworks), as YAML text so a
 * built-in and a project file hash, display and duplicate the same way. Detection (D6) walks them
 * in this order; `generic` has no `detect` and is the fallback.
 */

const SDD = 'node .ai/sdd/sdd.mjs';

/** `Plan ⏸ → Build → Review` — needs nothing installed (owner decision Q3). */
const GENERIC = `id: generic
name: Generic
description: Plan, build, review. Works on any repository with nothing installed.
cardFields:
  - { name: slug, label: Plan name, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', from: title }
stages:
  - id: plan
    name: Plan
    description: Read the code involved and write an implementation plan for this card to .ai/cezar/plans/{{card.slug}}.md. Do not change any other file.
    artifacts: [ '.ai/cezar/plans/{{card.slug}}.md' ]
    gate: { kind: approve, message: 'Approve the plan for this card?' }
  - id: build
    name: Build
    description: Implement the approved plan in .ai/cezar/plans/{{card.slug}}.md, with tests, and commit the work.
  - id: review
    name: Review
    description: Review the changes on this branch against the plan in .ai/cezar/plans/{{card.slug}}.md. Do not edit code; report what must change.
    review: true
    verdicts: [ approve, changes ]
    onVerdict: { changes: build }
    loopMax: 2
`;

/** Open Mercato SDD — open-mercato/sdd @ 04ba2cc (2026-11-22). Stage names are \`sdd.mjs\`'s own. */
const OPEN_MERCATO_SDD = `id: open-mercato-sdd
name: Open Mercato SDD
description: Discover, spec + plan, mockup, threat model, validate, implement, verify, archive.
detect:
  - .ai/sdd/sdd.mjs
requires:
  - .ai/sdd/sdd.mjs
  - .ai/sdd/CONVENTIONS.md
state:
  command: ${SDD} status --json
  watch: .ai/specs/*/change.json
cardFields:
  - { name: slug, label: Change id, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', from: title }
  - { name: ui, label: Changes a screen, type: boolean, default: true }
stages:
  - id: discover
    name: Discover
    skill: om-sdd-discover
    mode: conversation
    artifacts: [ '.ai/specs/*-{{card.slug}}/brief.md' ]
    gate: { kind: framework, approve: null }
  - id: spec
    name: Spec + plan
    skill: om-sdd-spec
    precheck: ${SDD} gate spec
    artifacts: [ '.ai/specs/*-{{card.slug}}/spec.md' ]
    gate: { kind: framework, approve: spec }
  - id: mockup
    name: Mockup
    skill: om-sdd-mockup
    precheck: ${SDD} gate mockup
    skipUnless: ui
    gate: { kind: framework, approve: mockup }
  - id: secure
    name: Secure
    skill: om-sdd-secure
    precheck: ${SDD} gate secure
    gate: { kind: framework, approve: secure }
  - id: validate
    name: Validate
    skill: om-sdd-validate
    precheck: ${SDD} gate validate
    verdicts: [ go, conditional, no-go ]
    onVerdict: { no-go: spec }
  - id: implement
    name: Implement
    skill: om-sdd-implement
    precheck: ${SDD} gate implement
    wip: 2
    checks: [ '${SDD} run-gate' ]
  - id: verify
    name: Verify
    skill: om-sdd-verify
    precheck: ${SDD} gate verify
    review: true
    verdicts: [ pass, fail ]
    onVerdict: { fail: implement }
    loopMax: 2
  - id: archive
    name: Archive
    skill: om-sdd-archive
    precheck: ${SDD} gate archive
`;

const OPENSPEC_FW = `id: openspec
name: OpenSpec
description: Change proposals under openspec/changes/, apply, archive into the living spec.
provisional: true
detect: [ ${OPENSPEC.detect.join(', ')} ]
stages:
  - id: proposal
    name: Proposal
    command: ${OPENSPEC.commands.proposal}
    gate: { kind: approve, message: 'Approve the change proposal?' }
  - id: apply
    name: Apply
    command: ${OPENSPEC.commands.apply}
  - id: archive
    name: Archive
    command: ${OPENSPEC.commands.archive}
`;

const SPEC_KIT_FW = `id: spec-kit
name: spec-kit
description: Constitution, specify, clarify, plan, tasks, analyze, implement. GitHub's SDD toolkit.
provisional: true
detect: [ ${SPEC_KIT.detect.join(', ')} ]
stages:
  - id: constitution
    name: Constitution
    command: ${SPEC_KIT.commands.constitution}
  - id: specify
    name: Specify
    command: ${SPEC_KIT.commands.specify}
  - id: clarify
    name: Clarify
    command: ${SPEC_KIT.commands.clarify}
    mode: conversation
  - id: plan
    name: Plan
    command: ${SPEC_KIT.commands.plan}
    gate: { kind: approve, message: 'Approve the plan?' }
  - id: tasks
    name: Tasks
    command: ${SPEC_KIT.commands.tasks}
  - id: analyze
    name: Analyze
    command: ${SPEC_KIT.commands.analyze}
  - id: implement
    name: Implement
    command: ${SPEC_KIT.commands.implement}
`;

/** Detection order (D6): the first built-in whose `detect` paths all exist wins. */
export const BUILTIN_FRAMEWORK_YAML: ReadonlyArray<{ id: string; yaml: string; install?: FrameworkInstallSource }> = [
  { id: 'open-mercato-sdd', yaml: OPEN_MERCATO_SDD, install: OPEN_MERCATO_SDD_INSTALL },
  { id: 'openspec', yaml: OPENSPEC_FW },
  { id: 'spec-kit', yaml: SPEC_KIT_FW },
  { id: 'generic', yaml: GENERIC },
];

export const FALLBACK_FRAMEWORK_ID = 'generic';

/** A built-in that cezar can install on an explicit click (`install.ts`); spec-kit's set-up stays shown, never run. */
export interface FrameworkInstallSource {
  /** For the commit message. */
  name: string;
  repo: string;
  label: string;
  /** A full commit sha: the checkout is verified against it. */
  ref: string;
  installer: string;
  writes: readonly string[];
  marker: string;
}

export function builtinInstallSource(id: string): FrameworkInstallSource | undefined {
  return BUILTIN_FRAMEWORK_YAML.find((f) => f.id === id)?.install;
}
