import { describe, expect, it, vi } from 'vitest'

import type { ApiRun, RunStatus } from '@open-mercato/cezar-api-client'
import type { GitAction } from '@/lib/git-actions'
import type { TaskWorkspaceBridge } from '@/lib/task-workspace-bridge'

import { buildTaskCommands, type TaskCommandHandlers, type TaskCommandInput } from './commands'

function run(status: RunStatus, extra: Partial<ApiRun> = {}): ApiRun {
  return {
    id: 'r1',
    title: 'Fix the login redirect',
    workflow: 'quick-task',
    task: 'fix it',
    status,
    createdAt: '2026-10-17T10:00:00Z',
    tokensUsed: 0,
    archived: false,
    steps: [{ name: 'do', status: 'done', sessionId: 'abc-123' }],
    ...extra,
  } as ApiRun
}

function handlers(): TaskCommandHandlers {
  return {
    markRead: vi.fn(),
    markUnread: vi.fn(),
    pin: vi.fn(),
    archive: vi.fn(),
    rename: vi.fn(),
    finish: vi.fn(),
    confirmStop: vi.fn(),
    confirmDelete: vi.fn(),
    resumeInTerminal: vi.fn(),
    gitAction: vi.fn(),
    openIn: vi.fn(),
    navigate: vi.fn(),
    openUrl: vi.fn(),
    copy: vi.fn(),
  }
}

function build(subject: ApiRun, extra: Partial<TaskCommandInput> = {}, on = handlers()) {
  const commands = buildTaskCommands(
    {
      run: subject,
      canResume: false,
      git: null,
      workspace: null,
      terminalAvailable: false,
      openChoices: [],
      taskUrl: 'http://127.0.0.1:4321/p/shop/tasks/r1',
      ...extra,
    },
    on,
  )
  return { commands, on, byId: new Map(commands.map((command) => [command.id, command])) }
}

function workspace(overrides: Partial<TaskWorkspaceBridge> = {}): TaskWorkspaceBridge {
  return {
    runId: 'r1',
    views: ['session', 'changes', 'commits', 'files'],
    activeView: 'session',
    openView: vi.fn(),
    openViewBeside: vi.fn(),
    layouts: [{ name: 'Review', label: 'Review', active: false }],
    selectLayout: vi.fn(),
    maximized: false,
    toggleMaximized: vi.fn(),
    splitView: null,
    terminal: { allowed: true, open: false, inColumn: false, toggle: vi.fn(), openInColumn: vi.fn() },
    focusComposer: vi.fn(),
    openFile: vi.fn(),
    markedUnread: vi.fn(),
    ...overrides,
  }
}

describe('the actions follow the header’s own rules (runActionFlags)', () => {
  it.each(['queued', 'running', 'waiting'] as RunStatus[])('%s: Stop offered; Archive and Delete greyed with the reason', (status) => {
    const { byId } = build(run(status))
    expect(byId.get('stop')).toBeDefined()
    expect(byId.get('archive')?.unavailable).toBe('Stop the task first')
    expect(byId.get('delete')?.unavailable).toBe('Stop the task first')
  })

  it.each(['review', 'done', 'failed', 'cancelled'] as RunStatus[])('%s: no Stop; Archive and Delete available', (status) => {
    const { byId } = build(run(status))
    expect(byId.has('stop')).toBe(false)
    expect(byId.get('archive')?.unavailable).toBeUndefined()
    expect(byId.get('delete')?.unavailable).toBeUndefined()
  })

  it('End session only for a waiting run; Accept only for one in review', () => {
    expect(build(run('waiting')).byId.has('end-session')).toBe(true)
    expect(build(run('waiting')).byId.has('accept')).toBe(false)
    expect(build(run('review')).byId.has('accept')).toBe(true)
    expect(build(run('done')).byId.has('end-session')).toBe(false)
  })

  it('a worktree operation in flight blocks Delete with its own reason', () => {
    const gated = run('done', { worktreeLifecycle: { activeOperationId: 'op1' } as ApiRun['worktreeLifecycle'] })
    expect(build(gated).byId.get('delete')?.unavailable).toBe('Resolve the worktree operation first')
  })

  it('pin flips its label and is unavailable on an archived run', () => {
    expect(build(run('done', { pinned: true })).byId.get('pin')).toMatchObject({ label: 'Unpin', pressed: true })
    expect(build(run('done', { archived: true })).byId.get('pin')?.unavailable).toBe('Archived tasks can’t be pinned')
  })

  it('read/unread appears only on a finished task, as whichever it is not', () => {
    expect(build(run('running')).byId.has('toggle-read')).toBe(false)
    const unread = build(run('done', { finishedAt: '2026-10-17T11:00:00Z' }))
    expect(unread.byId.get('toggle-read')?.label).toBe('Mark read')
    const read = build(run('done', { finishedAt: '2026-10-17T11:00:00Z', seenAt: '2026-10-17T12:00:00Z' }))
    expect(read.byId.get('toggle-read')?.label).toBe('Mark unread')
  })

  it('destructive commands only ask — they route to the confirm dialog', () => {
    const { byId, on } = build(run('running'))
    byId.get('stop')?.perform()
    expect(on.confirmStop).toHaveBeenCalled()
  })
})

describe('git', () => {
  const step: GitAction = {
    id: 'create-pr',
    label: 'Create PR',
    enabled: true,
    alternatives: [{ id: 'create-draft-pr', label: 'Create draft PR', enabled: false, reason: 'not now' }],
  }

  it('lists the step and its alternatives, a disabled one with its reason', () => {
    const { byId, on } = build(run('done'), { git: step })
    byId.get('git:create-pr')?.perform()
    expect(on.gitAction).toHaveBeenCalledWith('create-pr')
    expect(byId.get('git:create-draft-pr')?.unavailable).toBe('not now')
  })

  it('a step in flight makes every git entry unavailable, the shown one under the in-flight label', () => {
    // Mid-turn the policy may already show the NEXT step (Update branch → Create PR here).
    const { byId } = build(run('running'), { git: step, gitPending: 'update-branch' })
    expect(byId.get('git:create-pr')?.label).toBe('Updating branch…')
    expect(byId.get('git:create-pr')?.unavailable).toBe('Already in progress')
    expect(byId.get('git:create-draft-pr')?.label).toBe('Create draft PR')
    expect(byId.get('git:create-draft-pr')?.unavailable).toBe('Already in progress')
  })

  it('offers Open pull request only for an http PR link', () => {
    expect(build(run('done'), { prUrl: 'https://github.com/o/r/pull/7' }).byId.has('open-pr')).toBe(true)
    expect(build(run('done'), { prUrl: '#7' }).byId.has('open-pr')).toBe(false)
  })
})

describe('views', () => {
  it('on screen they switch the workspace, number keys as hints, Alt+Enter opens beside', () => {
    const bridge = workspace()
    const { byId } = build(run('done'), { workspace: bridge })
    const changes = byId.get('view:changes')
    expect(changes?.shortcut).toBe('2')
    changes?.perform()
    expect(bridge.openView).toHaveBeenCalledWith('changes')
    changes?.performBeside?.()
    expect(bridge.openViewBeside).toHaveBeenCalledWith('changes')
    expect(byId.get('view:session')?.pressed).toBe(true)
    // Notes is numbered after the views; saved layouts are not numbered at all.
    expect(byId.get('view:notes')?.shortcut).toBe('5')
    expect(byId.get('layout:Review')?.shortcut).toBeUndefined()
    expect(byId.get('tab:5')?.label).toBe('Tab 5: Notes')
    expect(byId.has('tab:6')).toBe(false)
  })

  it('⌘N works off the workspace too (the Notes page): tab:N navigates to the view', () => {
    const { byId, on } = build(run('done'))
    byId.get('tab:2')?.perform()
    expect(on.navigate).toHaveBeenCalledWith('/tasks/r1/changes')
    // Notes sits before Preview on the row, so it is the fifth tab.
    byId.get('tab:5')?.perform()
    expect(on.navigate).toHaveBeenCalledWith('/tasks/r1/notes')
    byId.get('tab:6')?.perform()
    expect(on.navigate).toHaveBeenCalledWith('/tasks/r1/preview')
  })

  it('for a task not on screen they navigate to its routes, with no layout commands', () => {
    const { byId, on, commands } = build(run('done'), { terminalAvailable: true })
    byId.get('view:changes')?.perform()
    expect(on.navigate).toHaveBeenCalledWith('/tasks/r1/changes')
    byId.get('view:terminal')?.perform()
    expect(on.navigate).toHaveBeenLastCalledWith('/tasks/r1/terminal')
    expect(byId.has('view:graph')).toBe(false)
    expect(commands.some((command) => command.group === 'layout')).toBe(false)
  })

  it('the composer and terminal commands follow what the workspace has', () => {
    expect(build(run('waiting'), { workspace: workspace({ focusComposer: null }) }).byId.has('reply')).toBe(false)
    const inColumn = workspace({ terminal: { allowed: true, open: false, inColumn: true, toggle: vi.fn(), openInColumn: vi.fn() } })
    const { byId } = build(run('done'), { workspace: inColumn })
    expect(byId.get('terminal')?.unavailable).toMatch(/column/)
    expect(byId.has('terminal-column')).toBe(false)
  })
})

describe('copy', () => {
  it('copies what the run has, and nothing it does not', () => {
    const { byId, on } = build(run('done', { branch: 'cez/r1' }))
    byId.get('copy:branch')?.perform()
    expect(on.copy).toHaveBeenCalledWith('cez/r1', 'Branch name')
    expect(byId.has('copy:path')).toBe(false)
    expect(byId.get('copy:link')).toBeDefined()
    expect(byId.get('copy:resume')).toBeDefined()
  })
})
