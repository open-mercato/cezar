import { describe, expect, it } from 'vitest'

import type { BackendCheck, Skill, WorkflowDef } from '@open-mercato/cezar-api-client'

import {
  buildAutomationTask,
  availableRunners,
  buildCreateRunBody,
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

  it('resolveModel keeps known picks and arbitrary native model pins', () => {
    expect(resolveModel('opus', 'claude')).toBe('opus')
    expect(resolveModel('custom-codex-id', 'codex')).toBe('custom-codex-id')
    expect(resolveModel(null, 'opencode', { opencode: 'provider/custom-model' })).toBe('provider/custom-model')
    expect(resolveModel(null, 'claude')).toBe('')
  })

  it('resolveModel falls back to the Settings → Agents per-runner preset (R6 1.5)', () => {
    const defaults = { claude: 'opus', codex: 'not-a-preset' }
    // Untouched pill: the configured preset for THIS runner preselects.
    expect(resolveModel(null, 'claude', defaults)).toBe('opus')
    // An explicit pick — including explicitly picking auto ('') — beats the preset.
    expect(resolveModel('sonnet', 'claude', defaults)).toBe('sonnet')
    expect(resolveModel('', 'claude', defaults)).toBe('')
    // Configured custom ids remain representable even when discovery is unavailable.
    expect(resolveModel(null, 'codex', defaults)).toBe('not-a-preset')
    // No preset for the runner → auto, exactly as before.
    expect(resolveModel(null, 'opencode', defaults)).toBe('')
  })
})

describe('resolveSource (candidate validation + cold quick-task default)', () => {
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

  it('defaults cold to quick-task, then first skill when quick-task is unavailable', () => {
    expect(resolveSource([], skills, workflows)).toEqual({ source: 'workflow', ref: 'quick-task' })
    expect(resolveSource([], skills, [workflow('fix-and-verify')])).toEqual({ source: 'skill', ref: 'om-fix' })
    expect(resolveSource([], [], workflows)).toEqual({ source: 'workflow', ref: 'quick-task' })
    expect(resolveSource([], [], [])).toEqual({ source: 'workflow', ref: 'quick-task' })
  })

  it('sourceExists checks the matching catalog only', () => {
    // A workflow name does not validate a skill ref, and vice versa.
    expect(sourceExists({ source: 'skill', ref: 'quick-task' }, skills, workflows)).toBe(false)
    expect(sourceExists({ source: 'workflow', ref: 'om-fix' }, skills, workflows)).toBe(false)
  })
})

describe('buildCreateRunBody — the exact POST /api/v1/runs payloads legacy sends', () => {
  it('workflow source → { workflow, task }, defaults omitted', () => {
    const body = buildCreateRunBody({
      task: 'do the thing',
      source: { source: 'workflow', ref: 'quick-task' },
      model: '',
      runner: 'claude',
      defaultRunner: 'claude',
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

  it('keeps a locked native default visible while omitting it from direct and automation requests', () => {
    const model = resolveModel(null, 'claude', { claude: 'native-sonnet' })
    expect(model).toBe('native-sonnet')

    const opts = {
      task: 'use the native model',
      source: { source: 'workflow' as const, ref: 'quick-task' },
      model,
      modelsLocked: true,
      runner: 'claude' as const,
      defaultRunner: 'claude' as const,
      variants: 1,
      images: [],
    }
    expect(buildCreateRunBody(opts).model).toBeUndefined()
    expect(buildAutomationTask(opts).model).toBeUndefined()
  })

  it('omits runner when the chosen connected runner equals the server default', () => {
    const body = buildCreateRunBody({
      task: 't', source: { source: 'workflow', ref: 'quick-task' }, model: '',
      runner: 'codex', defaultRunner: 'codex', variants: 1, images: [],
    })
    expect(body.runner).toBeUndefined()
  })

  it('keeps an explicit runner pick even when it equals the default snapshot', () => {
    const body = buildCreateRunBody({
      task: 't', source: { source: 'workflow', ref: 'quick-task' }, model: '',
      runner: 'codex', runnerExplicit: true, defaultRunner: 'codex', variants: 1, images: [],
    })
    expect(body.runner).toBe('codex')
  })

  it('sends a connected fallback that differs from the server default, even when it is the only choice', () => {
    const body = buildCreateRunBody({
      task: 't', source: { source: 'workflow', ref: 'quick-task' }, model: '',
      runner: 'codex', defaultRunner: 'claude', variants: 1, images: [],
    })
    expect(body.runner).toBe('codex')
  })

  it('worktree=false is sent only for a single run; on/variants keep it implicit', () => {
    const off = buildCreateRunBody({
      task: 't', source: { source: 'skill', ref: 'om-review' }, model: '',
      runner: 'claude', defaultRunner: 'claude', variants: 1, images: [], worktree: false,
    })
    expect(off.worktree).toBe(false)
    // Default (on) never sends the flag.
    const on = buildCreateRunBody({
      task: 't', source: { source: 'skill', ref: 'om-review' }, model: '',
      runner: 'claude', defaultRunner: 'claude', variants: 1, images: [], worktree: true,
    })
    expect(on.worktree).toBeUndefined()
    // Variants always isolate — worktree=false is ignored.
    const variant = buildCreateRunBody({
      task: 't', source: { source: 'skill', ref: 'om-review' }, model: '',
      runner: 'claude', defaultRunner: 'claude', variants: 2, images: [], worktree: false,
    })
    expect(variant.worktree).toBeUndefined()
  })

  it('generateFollowups=false is sent only when follow-up generation is disabled', () => {
    const base = {
      task: 't', source: { source: 'skill' as const, ref: 'om-review' }, model: '',
      runner: 'claude' as const, defaultRunner: 'claude' as const, variants: 1, images: [],
    }
    expect(buildCreateRunBody({ ...base, generateFollowups: false }).generateFollowups).toBe(false)
    expect(buildCreateRunBody({ ...base, generateFollowups: true }).generateFollowups).toBeUndefined()
    expect(buildCreateRunBody(base).generateFollowups).toBeUndefined()
  })

  it('variants > 1 and images ride along; ×1 and no images are omitted', () => {
    const body = buildCreateRunBody({
      task: 't', source: { source: 'workflow', ref: 'quick-task' }, model: '',
      runner: 'claude', defaultRunner: 'claude', variants: 3,
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

describe('buildAutomationTask', () => {
  it('uses the New task serializer while dropping one-shot transport fields', () => {
    expect(buildAutomationTask({
      task: 'Review {{github.url}}',
      source: { source: 'skill', ref: 'om-code-review' },
      model: 'opus',
      runner: 'claude',
      defaultRunner: 'claude',
      variants: 2,
      images: [{ mediaType: 'image/png', data: 'ignored' }],
      autonomous: true,
      todoId: 'ignored',
    })).toEqual({
      prompt: 'Review {{github.url}}',
      steps: [{ id: 'task', name: 'om-code-review', skill: 'om-code-review', prompt: '{{task}}' }],
      model: 'opus',
      variants: 2,
      autonomous: true,
    })
  })
})
