import { describe, expect, it } from 'vitest'

import type { BackendCheck, Skill, WorkflowDef } from '@/api/types'

import {
  HARNESS_MODES,
  HARNESS_PRESETS_MAX,
  HARNESS_PROFILE_OPTIONS,
  canSaveHarnessPreset,
  visibleHarnessPresets,
  advisorHarnessOptions,
  defaultHarnessRoles,
  freeTierReviewerWarning,
  groupHarnessOptions,
  harnessRolesIssue,
  modelFamilyOf,
  normalizeHarnessPresets,
  rolesEqual,
  availableRunners,
  buildCreateRunBody,
  harnessStartBlock,
  harnessSetupPrefill,
  harnessWorkflowName,
  withoutHarnessWorkflows,
  MODELS_BY_RUNNER,
  modelsForRunner,
  modelCatalogStatus,
  pushRecentSource,
  resolveModel,
  resolveRunner,
  resolveSource,
  sourceExists,
  startedRunPath,
  type TaskSource,
} from './new-task-form'

const check = (name: BackendCheck['name'], available: boolean): BackendCheck => ({ name, available })

const skill = (name: string, source: Skill['source'] = 'ai'): Skill => ({
  name,
  body: '',
  path: `/skills/${name}.md`,
  source,
})

const workflow = (name: string): WorkflowDef => ({ name, source: 'built-in', steps: [] })

describe('availableRunners (legacy renderChrome rule)', () => {
  it('offers exactly the detected backends, in RUNNERS order', () => {
    const checks = [check('opencode', true), check('git', true), check('claude', true), check('codex', false)]
    expect(availableRunners(checks)).toEqual(['claude', 'opencode'])
  })

  it('falls back to claude when nothing is detected — the form always has a runner', () => {
    expect(availableRunners([])).toEqual(['claude'])
    expect(availableRunners([check('git', true), check('gh', true)])).toEqual(['claude'])
  })
})

describe('resolveRunner (legacy preselection order)', () => {
  it('keeps the user pick while it is installed', () => {
    expect(resolveRunner('codex', ['claude', 'codex'], 'claude')).toBe('codex')
  })

  it('falls back to the configured default when the pick is gone', () => {
    expect(resolveRunner('opencode', ['claude', 'codex'], 'codex')).toBe('codex')
  })

  it('falls back to the first available when even the default is missing', () => {
    expect(resolveRunner(null, ['codex', 'opencode'], 'claude')).toBe('codex')
  })
})

describe('model option resolution', () => {
  it('every runner leads with auto (empty id — no model flag sent)', () => {
    for (const models of Object.values(MODELS_BY_RUNNER)) {
      expect(models[0]).toMatchObject({ id: '', label: 'auto' })
    }
  })

  it('claude: tier aliases + pinned versions, newest (Fable 5) first', () => {
    expect(modelsForRunner('claude').map((m) => m.id)).toEqual([
      '', 'opus', 'sonnet', 'haiku', 'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5',
    ])
  })

  it('codex: auto plus host-discovered and custom ids', () => {
    const catalog = { runner: 'codex' as const, models: [{ id: 'gpt-future', label: 'Future', description: 'New' }], source: 'live' as const, stale: false }
    expect(modelsForRunner('codex', catalog, ['legacy-id']).map((m) => m.id)).toEqual(['', 'gpt-future', 'legacy-id'])
    expect(modelsForRunner('codex', catalog, ['legacy-id']).at(-1)?.desc).toBe('Custom or legacy model')
  })

  it('reports stale and unavailable Codex catalogs without exposing reasons', () => {
    expect(modelCatalogStatus('codex', { runner: 'codex', models: [], source: 'cache', stale: true, reason: 'raw' })).toBe('Using cached Codex model list')
    expect(modelCatalogStatus('codex', { runner: 'codex', models: [], source: 'unavailable', stale: false, reason: 'raw' })).toBe('Latest Codex models unavailable')
    expect(modelCatalogStatus('claude', undefined, true)).toBeUndefined()
  })

  it('opencode: provider/model ids, newest Anthropic + OpenAI', () => {
    expect(modelsForRunner('opencode').map((m) => m.id)).toEqual([
      '', 'anthropic/claude-opus-4-8', 'anthropic/claude-sonnet-5', 'openai/gpt-5.1', 'openai/gpt-5.1-codex',
    ])
  })

  it('opencode: merges the live host catalog — a configured harness jury shows up (2026-07-24)', () => {
    const catalog = {
      runner: 'opencode' as const,
      models: [
        { id: 'deepseek/deepseek-v4-pro', label: 'deepseek-v4-pro', description: 'via deepseek' },
        { id: 'opencode/kimi-k2.7-code', label: 'kimi-k2.7-code', description: 'via opencode' },
        { id: 'anthropic/claude-opus-4-8', label: 'dupe', description: 'already a preset' },
      ],
      source: 'live' as const,
      stale: false,
    }
    const ids = modelsForRunner('opencode', catalog, ['custom/model']).map((m) => m.id)
    expect(ids).toEqual([
      '', 'anthropic/claude-opus-4-8', 'anthropic/claude-sonnet-5', 'openai/gpt-5.1', 'openai/gpt-5.1-codex',
      'deepseek/deepseek-v4-pro', 'opencode/kimi-k2.7-code', 'custom/model',
    ])
  })

  it('never merges a catalog fetched for another runner', () => {
    const codexCatalog = { runner: 'codex' as const, models: [{ id: 'gpt-future', label: 'F', description: '' }], source: 'live' as const, stale: false }
    expect(modelsForRunner('opencode', codexCatalog).some((m) => m.id === 'gpt-future')).toBe(false)
    expect(modelCatalogStatus('opencode', codexCatalog)).toBeUndefined()
  })

  it('reports stale and unavailable OpenCode catalogs with matching wording', () => {
    expect(modelCatalogStatus('opencode', { runner: 'opencode', models: [], source: 'cache', stale: true, reason: 'raw' })).toBe('Using cached OpenCode model list')
    expect(modelCatalogStatus('opencode', { runner: 'opencode', models: [], source: 'unavailable', stale: false, reason: 'raw' })).toBe('Latest OpenCode models unavailable')
  })

  it('resolveModel keeps known picks and arbitrary Codex pins', () => {
    expect(resolveModel('opus', 'claude')).toBe('opus')
    expect(resolveModel('custom-codex-id', 'codex')).toBe('custom-codex-id')
    expect(resolveModel(null, 'claude')).toBe('')
  })

  it('resolveModel falls back to the Settings → Agents per-runner preset (R6 1.5)', () => {
    const defaults = { claude: 'opus', codex: 'not-a-preset' }
    // Untouched pill: the configured preset for THIS runner preselects.
    expect(resolveModel(null, 'claude', defaults)).toBe('opus')
    // An explicit pick — including explicitly picking auto ('') — beats the preset.
    expect(resolveModel('sonnet', 'claude', defaults)).toBe('sonnet')
    expect(resolveModel('', 'claude', defaults)).toBe('')
    // Configured Codex ids remain representable even when discovery is unavailable.
    expect(resolveModel(null, 'codex', defaults)).toBe('not-a-preset')
    // No preset for the runner → auto, exactly as before.
    expect(resolveModel(null, 'opencode', defaults)).toBe('')
  })
})

describe('resolveSource (legacy lastTask validation + defaultTaskSource)', () => {
  const skills = [skill('om-fix'), skill('deploy', 'global')]
  const workflows = [workflow('quick-task'), workflow('fix-and-verify')]

  it('takes the first candidate that still exists', () => {
    expect(
      resolveSource(
        [{ source: 'skill', ref: 'gone' }, { source: 'workflow', ref: 'fix-and-verify' }],
        skills,
        workflows,
      ),
    ).toEqual({ source: 'workflow', ref: 'fix-and-verify' })
  })

  it('defaults to the FIRST SKILL (skills-first, feedback 2026-07-11), then first workflow, then quick-task', () => {
    expect(resolveSource([], skills, workflows)).toEqual({ source: 'skill', ref: 'om-fix' })
    expect(resolveSource([], [], workflows)).toEqual({ source: 'workflow', ref: 'quick-task' })
    expect(resolveSource([], [], [])).toEqual({ source: 'workflow', ref: 'quick-task' })
  })

  it('sourceExists checks the matching catalog only', () => {
    // A workflow name does not validate a skill ref, and vice versa.
    expect(sourceExists({ source: 'skill', ref: 'quick-task' }, skills, workflows)).toBe(false)
    expect(sourceExists({ source: 'workflow', ref: 'om-fix' }, skills, workflows)).toBe(false)
  })
})

describe('buildCreateRunBody — the exact POST /api/runs payloads legacy sends', () => {
  it('workflow source → { workflow, task }, defaults omitted', () => {
    const body = buildCreateRunBody({
      task: 'do the thing',
      source: { source: 'workflow', ref: 'quick-task' },
      model: '',
      runner: 'claude',
      runnerCount: 1,
      variants: 1,
      images: [],
    })
    expect(body).toEqual({
      task: 'do the thing',
      workflow: 'quick-task',
      model: undefined,
      runner: undefined,
      variants: undefined,
      images: undefined,
    })
    // What actually goes over the wire: the undefineds vanish.
    expect(JSON.parse(JSON.stringify(body))).toEqual({ task: 'do the thing', workflow: 'quick-task' })
  })

  it('skill source → the one-step inline chain (spec 008: same shape as inbox/bookmarklet)', () => {
    const body = buildCreateRunBody({
      task: 'fix the flake',
      source: { source: 'skill', ref: 'om-fix' },
      model: 'sonnet',
      runner: 'claude',
      runnerCount: 2,
      defaultRunner: 'codex',
      variants: 1,
      images: [],
    })
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      task: 'fix the flake',
      steps: [{ id: 'task', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' }],
      model: 'sonnet',
      runner: 'claude',
    })
  })

  it('sends the only available runner when it differs from the unavailable server default', () => {
    const single = buildCreateRunBody({
      task: 't', source: { source: 'workflow', ref: 'quick-task' }, model: '',
      runner: 'claude', runnerCount: 1, defaultRunner: 'codex', variants: 1, images: [],
    })
    expect(single.runner).toBe('claude')
  })

  it('still omits the runner when it matches the server default', () => {
    const body = buildCreateRunBody({
      task: 't', source: { source: 'workflow', ref: 'quick-task' }, model: '',
      runner: 'claude', runnerCount: 2, defaultRunner: 'claude', variants: 1, images: [],
    })
    expect(body.runner).toBeUndefined()
  })

  it('worktree=false is sent only for a single run; on/variants keep it implicit', () => {
    const off = buildCreateRunBody({
      task: 't', source: { source: 'skill', ref: 'om-review' }, model: '',
      runner: 'claude', runnerCount: 1, variants: 1, images: [], worktree: false,
    })
    expect(off.worktree).toBe(false)
    // Default (on) never sends the flag.
    const on = buildCreateRunBody({
      task: 't', source: { source: 'skill', ref: 'om-review' }, model: '',
      runner: 'claude', runnerCount: 1, variants: 1, images: [], worktree: true,
    })
    expect(on.worktree).toBeUndefined()
    // Variants always isolate — worktree=false is ignored.
    const variant = buildCreateRunBody({
      task: 't', source: { source: 'skill', ref: 'om-review' }, model: '',
      runner: 'claude', runnerCount: 1, variants: 2, images: [], worktree: false,
    })
    expect(variant.worktree).toBeUndefined()
  })

  it('generateFollowups=false is sent only when follow-up generation is disabled', () => {
    const base = {
      task: 't', source: { source: 'skill' as const, ref: 'om-review' }, model: '',
      runner: 'claude' as const, runnerCount: 1, variants: 1, images: [],
    }
    expect(buildCreateRunBody({ ...base, generateFollowups: false }).generateFollowups).toBe(false)
    expect(buildCreateRunBody({ ...base, generateFollowups: true }).generateFollowups).toBeUndefined()
    expect(buildCreateRunBody(base).generateFollowups).toBeUndefined()
  })

  it('variants > 1 and images ride along; ×1 and no images are omitted', () => {
    const body = buildCreateRunBody({
      task: 't', source: { source: 'workflow', ref: 'quick-task' }, model: '',
      runner: 'claude', runnerCount: 1, variants: 3,
      images: [{ mediaType: 'image/png', data: 'aGk=' }],
    })
    expect(body.variants).toBe(3)
    expect(body.images).toEqual([{ mediaType: 'image/png', data: 'aGk=' }])
  })
})

describe('startedRunPath (legacy handleStarted: select the first run)', () => {
  const record = { id: 'r1' } as never

  it('×1: the created run’s thread', () => {
    expect(startedRunPath(record)).toBe('/tasks/r1')
  })

  it('×2/×3: the FIRST variant’s thread', () => {
    expect(startedRunPath({ runs: [{ id: 'v-a' }, { id: 'v-b' }] as never })).toBe('/tasks/v-a')
  })
})

describe('pushRecentSource (recency, #picker)', () => {
  const s = (ref: string, source: TaskSource['source'] = 'skill'): TaskSource => ({ source, ref })

  it('prepends newest and dedups the same source+ref', () => {
    const after = pushRecentSource([s('a'), s('b')], s('b'))
    expect(after).toEqual([s('b'), s('a')])
  })

  it('treats skill and workflow with the same ref as distinct', () => {
    const after = pushRecentSource([s('x', 'skill')], s('x', 'workflow'))
    expect(after).toEqual([s('x', 'workflow'), s('x', 'skill')])
  })

  it('caps the list length', () => {
    const seed = Array.from({ length: 24 }, (_, i) => s(`k${i}`))
    const after = pushRecentSource(seed, s('new'), 24)
    expect(after).toHaveLength(24)
    expect(after[0]).toEqual(s('new'))
    expect(after.at(-1)).toEqual(s('k22')) // k23 fell off the end
  })

  it('handles an undefined starting list', () => {
    expect(pushRecentSource(undefined, s('a'))).toEqual([s('a')])
  })
})

describe('harness form rules (spec 2026-07-23-harness-orchestration)', () => {
  it('harnessSetupPrefill selects the vendored setup skill and opts out of the worktree', () => {
    const prefill = harnessSetupPrefill()
    expect(prefill.source).toEqual({ source: 'skill', ref: 'cez-setup-harness' })
    expect(prefill.composerMode).toBe('task')
    // Setup stages .ai/agentic.config.json + hooks in the real repo for the
    // human to review — a throwaway worktree would strand them on a cez/
    // branch (and a stale base once hid the config entirely: run 9788d87f).
    expect(prefill.worktree).toBe(false)
    expect(prefill.text).toContain('Configure the multi-model agent harness')
  })

  it('advisorHarnessOptions turns configured reviewer bindings into council options (2026-07-24)', () => {
    const status = {
      configured: true,
      profiles: ['standard', 'multi'],
      driven: ['standard'],
      runtime: { installed: true, source: 'bundled' as const, commit: 'a'.repeat(40) },
      models: [
        { id: 'claude', family: 'anthropic', model: 'host app', adapter: 'host', roles: ['host', 'reviewer'] },
        { id: 'kimi', family: 'moonshot', model: 'kimi-code/k3', adapter: 'preset', roles: ['reviewer'] },
        { id: 'codex', family: 'openai', model: 'gpt-5.6-sol', adapter: 'command', roles: ['worker', 'reviewer'] },
        { id: 'mystery', roles: [] as string[] }, // no adapter → not an advisor binding
      ],
    }
    expect(advisorHarnessOptions(status)).toEqual([
      { runner: 'harness', model: 'kimi', label: 'kimi · kimi-code/k3', family: 'moonshot' },
      { runner: 'harness', model: 'codex', label: 'codex · gpt-5.6-sol', family: 'openai' },
    ])
    expect(advisorHarnessOptions(undefined)).toEqual([])
    // Family flows into the diversity rule.
    expect(modelFamilyOf({ runner: 'harness', model: 'kimi', family: 'moonshot' })).toBe('moonshot')
  })

  it('defaultHarnessRoles never defaults to an advisor — they are an explicit choice', () => {
    const options = [
      { runner: 'claude' as const, model: 'sonnet', label: 'sonnet', family: 'anthropic' },
      { runner: 'codex' as const, model: '', label: 'auto', family: 'openai' },
      { runner: 'harness' as const, model: 'kimi', label: 'kimi', family: 'moonshot' },
    ]
    const defaults = defaultHarnessRoles(options)
    expect(defaults).not.toBeNull()
    const refs = [defaults!.orchestrator, defaults!.implementer, ...defaults!.reviewers]
    expect(refs.every((ref) => ref.runner !== 'harness')).toBe(true)
  })

  it('harnessWorkflowName recognizes exactly the two harness workflows', () => {
    expect(harnessWorkflowName({ source: 'workflow', ref: 'harness-fix-issue' })).toBe('harness-fix-issue')
    expect(harnessWorkflowName({ source: 'workflow', ref: 'harness-implement-feature' })).toBe(
      'harness-implement-feature',
    )
    expect(harnessWorkflowName({ source: 'workflow', ref: 'quick-task' })).toBeNull()
    expect(harnessWorkflowName({ source: 'skill', ref: 'harness-fix-issue' })).toBeNull()
  })

  it('offers all five profiles with standard first, under human names', () => {
    expect(HARNESS_PROFILE_OPTIONS.map((p) => p.id)).toEqual([
      'standard',
      'optimized',
      'multi',
      'multi-optimized',
      'high-assurance',
    ])
    // Wire ids stay om-config protocol; labels are what people read (user
    // feedback 2026-07-23: names must say what the mode actually does).
    expect(HARNESS_PROFILE_OPTIONS.map((p) => p.label)).toEqual([
      'Claude solo',
      'Worker offload',
      'Review council',
      'Council + worker',
      'High assurance',
    ])
  })

  it('exposes the two multi-model modes with plain names', () => {
    expect(HARNESS_MODES.map((m) => m.id)).toEqual(['fix-issue', 'implement-feature'])
    expect(HARNESS_MODES.map((m) => m.workflow)).toEqual(['harness-fix-issue', 'harness-implement-feature'])
    expect(HARNESS_MODES.map((m) => m.label)).toEqual(['Fix an issue', 'Build a feature'])
  })

  it('withoutHarnessWorkflows hides the harness entries from the Task tab picker', () => {
    const list = [workflow('quick-task'), workflow('harness-fix-issue'), workflow('harness-implement-feature')]
    expect(withoutHarnessWorkflows(list).map((w) => w.name)).toEqual(['quick-task'])
  })

  it('harnessStartBlock passes a ready probe and reports a blocked one', () => {
    expect(harnessStartBlock({ profile: 'standard', ready: true, models: [] })).toBeNull()
    expect(
      harnessStartBlock({ profile: 'multi', ready: false, reason: 'not yet driven', models: [] }),
    ).toBe('not yet driven')
    expect(harnessStartBlock({ profile: 'multi', ready: false, models: [] })).toMatch(/not ready/)
    // No probe answer yet — don't block the button on a loading state.
    expect(harnessStartBlock(undefined)).toBeNull()
  })

  it('buildCreateRunBody sends the profile for harness workflows only', () => {
    const base = {
      task: 'Fix issue #642',
      model: '',
      runner: 'claude' as const,
      runnerCount: 1,
      variants: 1,
      images: [],
    }
    const harness = buildCreateRunBody({
      ...base,
      source: { source: 'workflow', ref: 'harness-fix-issue' },
      harnessProfile: 'standard',
    })
    expect(harness.workflow).toBe('harness-fix-issue')
    expect(harness.harness).toEqual({ profile: 'standard' })
    const plain = buildCreateRunBody({
      ...base,
      source: { source: 'workflow', ref: 'quick-task' },
      harnessProfile: 'standard',
    })
    expect(plain.harness).toBeUndefined()
    const skillRun = buildCreateRunBody({
      ...base,
      source: { source: 'skill', ref: 'om-fix' },
      harnessProfile: 'multi',
    })
    expect(skillRun.harness).toBeUndefined()
  })
})

describe('harness role selection (role-based multi-model, 2026-07-24)', () => {
  const ref = (runner: 'claude' | 'codex' | 'opencode', model: string) => ({ runner, model })

  it('derives the provider family from the runner and model', () => {
    expect(modelFamilyOf(ref('claude', 'sonnet'))).toBe('anthropic')
    expect(modelFamilyOf(ref('codex', 'gpt-5.6-sol'))).toBe('openai')
    expect(modelFamilyOf(ref('opencode', 'deepseek/deepseek-v4'))).toBe('deepseek')
    expect(modelFamilyOf(ref('opencode', 'anthropic/claude-sonnet-5'))).toBe('anthropic')
    expect(modelFamilyOf(ref('opencode', ''))).toBe('opencode')
  })

  it('validates a sound role selection', () => {
    expect(
      harnessRolesIssue({
        orchestrator: ref('claude', 'sonnet'),
        implementer: ref('codex', ''),
        reviewers: [ref('claude', 'opus'), ref('codex', 'gpt-5.6-sol')],
      }),
    ).toBeNull()
  })

  it('requires 2–5 reviewers', () => {
    const roles = {
      orchestrator: ref('claude', 'sonnet'),
      implementer: ref('claude', 'opus'),
      reviewers: [ref('claude', 'opus')],
    }
    expect(harnessRolesIssue(roles)).toMatch(/at least 2 reviewers/i)
    expect(
      harnessRolesIssue({
        ...roles,
        reviewers: [
          ref('claude', 'opus'),
          ref('claude', 'sonnet'),
          ref('claude', 'haiku'),
          ref('codex', ''),
          ref('opencode', 'openai/gpt-5.1'),
          ref('opencode', 'deepseek/deepseek-v4'),
        ],
      }),
    ).toMatch(/at most 5/i)
  })

  it('rejects duplicate reviewers', () => {
    expect(
      harnessRolesIssue({
        orchestrator: ref('claude', 'sonnet'),
        implementer: ref('codex', ''),
        reviewers: [ref('claude', 'opus'), ref('claude', 'opus')],
      }),
    ).toMatch(/unique/i)
  })

  it('rejects a single-family council — the tab is strictly multi-model', () => {
    expect(
      harnessRolesIssue({
        orchestrator: ref('claude', 'sonnet'),
        implementer: ref('claude', 'opus'),
        reviewers: [ref('claude', 'opus'), ref('claude', 'haiku')],
      }),
    ).toMatch(/different model famil/i)
  })

  it('builds default roles from the available catalog, spanning two families', () => {
    const options = [
      { runner: 'claude' as const, model: 'sonnet', label: 'sonnet', family: 'anthropic' },
      { runner: 'claude' as const, model: 'opus', label: 'opus', family: 'anthropic' },
      { runner: 'codex' as const, model: '', label: 'auto', family: 'openai' },
    ]
    const roles = defaultHarnessRoles(options)
    expect(roles).not.toBeNull()
    expect(roles?.orchestrator.runner).toBe('claude')
    expect(harnessRolesIssue(roles!)).toBeNull()
  })

  it('returns null defaults when fewer than two families exist — the modal case', () => {
    expect(
      defaultHarnessRoles([
        { runner: 'claude' as const, model: 'sonnet', label: 'sonnet', family: 'anthropic' },
        { runner: 'claude' as const, model: 'opus', label: 'opus', family: 'anthropic' },
      ]),
    ).toBeNull()
  })

  it('buildCreateRunBody carries roles for the multi tab', () => {
    const roles = {
      orchestrator: ref('claude', 'sonnet'),
      implementer: ref('codex', ''),
      reviewers: [ref('claude', 'opus'), ref('codex', 'gpt-5.6-sol')],
    }
    const body = buildCreateRunBody({
      task: 'Build the CSV export module',
      source: { source: 'workflow', ref: 'harness-implement-feature' },
      model: '',
      runner: 'claude',
      runnerCount: 1,
      variants: 1,
      images: [],
      harnessRoles: roles,
    })
    expect(body.harness).toEqual({ roles })
  })
})

describe('harness picker grouping and presets (2026-07-24)', () => {
  const opts = [
    { runner: 'opencode' as const, model: 'deepseek/deepseek-v4', label: 'deepseek-v4', family: 'deepseek' },
    { runner: 'claude' as const, model: 'sonnet', label: 'sonnet', family: 'anthropic' },
    { runner: 'codex' as const, model: '', label: 'auto', family: 'openai' },
    { runner: 'opencode' as const, model: 'anthropic/claude-sonnet-5', label: 'claude-sonnet-5', family: 'anthropic' },
  ]

  it('groups options by provider family, anthropic and openai first', () => {
    const groups = groupHarnessOptions(opts)
    expect(groups.map((g) => g.family)).toEqual(['anthropic', 'openai', 'deepseek'])
    expect(groups[0]?.options.map((o) => o.label)).toEqual(['sonnet', 'claude-sonnet-5'])
  })

  it('normalizes presets from loose ui-state data and caps them', () => {
    const roles = {
      orchestrator: { runner: 'claude', model: 'sonnet' },
      implementer: { runner: 'codex', model: '' },
      reviewers: [
        { runner: 'claude', model: 'opus' },
        { runner: 'codex', model: '' },
      ],
    }
    const good = { id: 'p1', name: 'Council of two', roles }
    expect(normalizeHarnessPresets([good])).toEqual([good])
    expect(normalizeHarnessPresets(undefined)).toEqual([])
    expect(normalizeHarnessPresets([{ id: 'x', name: 'bad', roles: { nope: true } }, good])).toEqual([good])
    const many = Array.from({ length: HARNESS_PRESETS_MAX + 4 }, (_, i) => ({ ...good, id: `p${i}`, name: `P${i}` }))
    expect(normalizeHarnessPresets(many)).toHaveLength(HARNESS_PRESETS_MAX)
  })

  it('rolesEqual compares selections structurally', () => {
    const a = {
      orchestrator: { runner: 'claude' as const, model: 'sonnet' },
      implementer: { runner: 'codex' as const, model: '' },
      reviewers: [
        { runner: 'claude' as const, model: 'opus' },
        { runner: 'codex' as const, model: '' },
      ],
    }
    expect(rolesEqual(a, { ...a })).toBe(true)
    expect(rolesEqual(a, { ...a, reviewers: [...a.reviewers].reverse() })).toBe(false)
    expect(rolesEqual(a, { ...a, orchestrator: { runner: 'claude', model: 'opus' } })).toBe(false)
  })
})

describe('harness reasoning effort (2026-07-24)', () => {
  const base = {
    orchestrator: { runner: 'claude' as const, model: 'sonnet' },
    implementer: { runner: 'codex' as const, model: '' },
    reviewers: [
      { runner: 'claude' as const, model: 'opus' },
      { runner: 'codex' as const, model: '' },
    ],
  }

  it('rolesEqual distinguishes effort — a preset restores the whole dial', () => {
    const withEffort = { ...base, implementer: { ...base.implementer, effort: 'max' as const } }
    expect(rolesEqual(base, withEffort)).toBe(false)
    expect(rolesEqual(withEffort, { ...withEffort })).toBe(true)
  })

  it('uniqueness ignores effort — the same model twice is still a duplicate reviewer', () => {
    expect(
      harnessRolesIssue({
        ...base,
        reviewers: [
          { runner: 'claude', model: 'opus', effort: 'low' },
          { runner: 'claude', model: 'opus', effort: 'max' },
        ],
      }),
    ).toMatch(/unique/i)
  })

  it('preset normalization keeps a valid effort and strips an invalid one', () => {
    const presets = normalizeHarnessPresets([
      {
        id: 'p1',
        name: 'Dialed',
        roles: {
          ...base,
          implementer: { runner: 'codex', model: '', effort: 'max' },
          orchestrator: { runner: 'claude', model: 'sonnet', effort: 'turbo' },
        },
      },
    ])
    expect(presets[0]?.roles.implementer.effort).toBe('max')
    expect(presets[0]?.roles.orchestrator.effort).toBeUndefined()
  })
})

describe('preset cap + overflow (2026-07-24, "what if 100 presets?")', () => {
  const roles = {
    orchestrator: { runner: 'claude' as const, model: 'sonnet' },
    implementer: { runner: 'codex' as const, model: '' },
    reviewers: [
      { runner: 'claude' as const, model: 'opus' },
      { runner: 'codex' as const, model: '' },
    ],
  }
  const preset = (i: number) => ({ id: `p${i}`, name: `P${i}`, roles })
  const many = (n: number) => Array.from({ length: n }, (_, i) => preset(i))

  it('caps at 12 with an explicit refusal — never silent eviction', () => {
    expect(HARNESS_PRESETS_MAX).toBe(12)
    expect(canSaveHarnessPreset(many(11), 'fresh').ok).toBe(true)
    const full = canSaveHarnessPreset(many(12), 'fresh')
    expect(full.ok).toBe(false)
    expect(full.ok === false && full.reason).toMatch(/12 presets/i)
  })

  it('replacing an existing name is allowed even at the cap', () => {
    expect(canSaveHarnessPreset(many(12), 'P3').ok).toBe(true)
  })

  it('normalization tolerates a hoard (e.g. a hand-edited 100) by keeping the first 12', () => {
    expect(normalizeHarnessPresets(many(100))).toHaveLength(12)
  })

  it('splits presets into 3 visible chips and an overflow', () => {
    const { visible, overflow } = visibleHarnessPresets(many(7), null)
    expect(visible.map((p) => p.name)).toEqual(['P0', 'P1', 'P2'])
    expect(overflow).toHaveLength(4)
  })

  it('keeps the ACTIVE preset visible even when it lives in the overflow', () => {
    const presets = many(7)
    const activeRoles = { ...roles, implementer: { runner: 'codex' as const, model: '', effort: 'max' as const } }
    presets[5] = { ...presets[5]!, roles: activeRoles }
    const { visible, overflow } = visibleHarnessPresets(presets, activeRoles)
    expect(visible.map((p) => p.name)).toEqual(['P0', 'P1', 'P2', 'P5'])
    expect(overflow.map((p) => p.name)).not.toContain('P5')
  })

  it('shows everything inline when at or under the visible budget', () => {
    const { visible, overflow } = visibleHarnessPresets(many(3), null)
    expect(visible).toHaveLength(3)
    expect(overflow).toHaveLength(0)
  })
})

describe('freeTierReviewerWarning', () => {
  const roles = (reviewers: Array<{ runner: string; model: string }>) =>
    ({
      orchestrator: { runner: 'claude', model: 'sonnet' },
      implementer: { runner: 'codex', model: 'gpt-5.6-sol' },
      reviewers,
    }) as Parameters<typeof freeTierReviewerWarning>[0]

  it('warns when a free-tier model is bound to a reviewer slot', () => {
    // Live failure: mimo-v2.5-free burned two 60-minute budgets on one review.
    const warning = freeTierReviewerWarning(
      roles([
        { runner: 'claude', model: 'opus' },
        { runner: 'opencode', model: 'opencode/mimo-v2.5-free' },
      ]),
    )
    expect(warning).toContain('mimo-v2.5-free')
    expect(warning).toMatch(/free-tier/)
  })

  it('says nothing when every reviewer is a paid tier', () => {
    expect(
      freeTierReviewerWarning(
        roles([
          { runner: 'claude', model: 'opus' },
          { runner: 'opencode', model: 'opencode/glm-5.2' },
        ]),
      ),
    ).toBeNull()
  })

  it('ignores a free-tier model outside the reviewer slots', () => {
    const r = roles([{ runner: 'claude', model: 'opus' }])
    r!.implementer = { runner: 'opencode', model: 'opencode/mimo-v2.5-free' }
    expect(freeTierReviewerWarning(r)).toBeNull()
  })

  it('names each distinct free model once', () => {
    const warning = freeTierReviewerWarning(
      roles([
        { runner: 'opencode', model: 'opencode/mimo-v2.5-free' },
        { runner: 'opencode', model: 'opencode/mimo-v2.5-free' },
        { runner: 'opencode', model: 'opencode/deepseek-v4-flash-free' },
      ]),
    )
    expect(warning!.match(/mimo-v2\.5-free/g)).toHaveLength(1)
    expect(warning).toContain('deepseek-v4-flash-free')
    expect(warning).toContain('are free-tier models')
  })

  it('handles no lineup at all', () => {
    expect(freeTierReviewerWarning(null)).toBeNull()
  })
})
