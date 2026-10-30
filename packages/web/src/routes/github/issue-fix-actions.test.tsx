import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setApiScope, type GithubItem } from '@open-mercato/cezar-api-client'
import { createRun } from '@/api/client'
import { githubRunBody } from '@/lib/github-task'
import { IssueFixRowControls, IssueFixToolbar, useIssueFixActions, type IssueFixActions } from './issue-fix-actions'

const issue = (n: number, kind: GithubItem['kind'] = 'issue'): GithubItem => ({ kind, number: n, title: `Issue ${n}`,
  url: `https://github.com/demo/repo/${kind === 'pr' ? 'pull' : 'issues'}/${n}`, author: 'demo',
  createdAt: '2026-10-30T10:00:00Z', labels: [], comments: 0 })
const first = issue(1), second = issue(2), third = issue(3)
let current: IssueFixActions
function Harness({ items = [first, second, third], queued = new Map(), contextKey = 'project-a', unavailable, launch }: {
  items?: readonly GithubItem[]; queued?: ReadonlyMap<string, string>; contextKey?: string;
  unavailable?: string; launch: (item: GithubItem) => Promise<void>
}) {
  current = useIssueFixActions({ items, queued, contextKey, unavailable, launch })
  return <><IssueFixToolbar actions={current} engineLabel="remembered engine" />
    {items.map((item, index) => <div key={index}><IssueFixRowControls item={item} actions={current} queued={queued.has(item.url)} /></div>)}</>
}
const choose = (n: number) => fireEvent.click(screen.getByRole('checkbox', { name: `Select issue #${n}` }))
afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })

describe('Issue fix selection and launch (#1621)', () => {
  it('requires bulk confirmation, cancels without launch, then posts only selected eligible URLs', async () => {
    const launch = vi.fn().mockResolvedValue(undefined)
    render(<Harness launch={launch} queued={new Map([[third.url, 'queued-run']])} />)
    choose(1); choose(3)
    fireEvent.click(screen.getByRole('button', { name: 'Queue fixes (1)' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(launch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(launch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Queue fixes (1)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Queue 1 tasks' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('1 queued, 1 skipped, 0 failed'))
    expect(launch.mock.calls.map(([item]) => item.url)).toEqual([first.url])
    expect((screen.getByRole('button', { name: 'Queue fix for issue #1' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('serializes, locks duplicate clicks and preserves failures for explicit retry', async () => {
    let release: (() => void) | undefined
    const launch = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
      .mockRejectedValueOnce(new Error('Permission denied')).mockResolvedValue(undefined)
    render(<Harness launch={launch} items={[first, second]} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select displayed issues' }))
    fireEvent.click(screen.getByRole('button', { name: 'Queue fixes (2)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Queue 2 tasks' }))
    await act(async () => { void current.apply([first, second]) })
    expect(launch).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('checkbox', { name: 'Select issue #2' }) as HTMLInputElement).disabled).toBe(true)
    await act(async () => release?.())
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('1 queued, 0 skipped, 1 failed'))
    expect(screen.getByRole('status').textContent).toContain('Check Tasks before retrying')
    expect(screen.getByText('1 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Queue fix for issue #2' }))
    await waitFor(() => expect(launch).toHaveBeenCalledTimes(3))
    expect(launch.mock.calls[2]?.[0].url).toBe(second.url)
    await act(async () => current.apply([first]))
    expect(launch).toHaveBeenCalledTimes(3)
  })

  it('uses one launch for duplicate issue URLs and never launches PR items', async () => {
    const launch = vi.fn().mockResolvedValue(undefined)
    render(<Harness launch={launch} items={[first]} />)
    await act(async () => current.apply([first, first, issue(4, 'pr')]))
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('prunes hidden selections and resets confirmation on context changes', () => {
    const launch = vi.fn().mockResolvedValue(undefined)
    const view = render(<Harness launch={launch} items={[first, second]} />)
    choose(2)
    view.rerender(<Harness launch={launch} items={[first]} />)
    view.rerender(<Harness launch={launch} items={[first, second]} />)
    expect((screen.getByRole('checkbox', { name: 'Select issue #2' }) as HTMLInputElement).checked).toBe(false)
    choose(1)
    fireEvent.click(screen.getByRole('button', { name: 'Queue fixes (1)' }))
    view.rerender(<Harness launch={launch} contextKey="project-b" />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('1 selected')).toBeNull()
  })

  it('refuses unavailable launches and oversized batches without truncation', async () => {
    const launch = vi.fn().mockResolvedValue(undefined)
    const view = render(<Harness launch={launch} unavailable="Install om-auto-fix-issue to queue fixes." />)
    await act(async () => current.apply([first]))
    expect(launch).not.toHaveBeenCalled()
    const many = Array.from({ length: 21 }, (_, i) => issue(i + 1))
    view.rerender(<Harness launch={launch} items={many} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select displayed issues' }))
    expect(screen.getByText('21 selected')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Queue fixes (21)' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => current.apply(many))
    expect(launch).not.toHaveBeenCalled()
    expect(current.displayed).toHaveLength(21)
  })

  it('retains the original launch closure across project navigation without new-scope queued pollution', async () => {
    let release: (() => void) | undefined
    const oldLaunch = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve })).mockResolvedValue(undefined)
    const newLaunch = vi.fn().mockResolvedValue(undefined)
    const view = render(<Harness launch={oldLaunch} items={[first, second]} />)
    let pending: Promise<void> | undefined
    act(() => { pending = current.apply([first, second]) })
    view.rerender(<Harness launch={newLaunch} contextKey="project-b" queued={new Map([[second.url, 'other-project-run']])} />)
    await act(async () => { release?.(); await pending })
    expect(oldLaunch.mock.calls.map(([item]) => item.url)).toEqual([first.url, second.url])
    expect(newLaunch).not.toHaveBeenCalled()
    expect(current.isQueued(first.url)).toBe(false)
    expect(screen.getByRole('status').textContent).toBe('')
  })
})

describe('Scoped canonical run creation (#1621)', () => {
  it('posts the canonical fix skill body to a captured scope even after active scope changes', async () => {
    const posts: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ id: 'created-run' }), { headers: { 'content-type': 'application/json' } })
    }))
    setApiScope('project-b')
    const body = githubRunBody(first, null, ['om-auto-fix-issue'], undefined, { runner: 'codex', model: 'test-model' })
    await createRun(body, 'project-a')
    await createRun(body)
    expect(posts).toEqual([{ url: '/api/v1/p/project-a/runs', body }, { url: '/api/v1/p/project-b/runs', body }])
    expect(body.steps?.map((step) => step.skill)).toEqual(['om-auto-fix-issue'])
    expect(body.task).toContain(first.url)
    expect(body.runner).toBe('codex')
  })
})
