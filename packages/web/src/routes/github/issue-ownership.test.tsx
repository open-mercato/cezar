import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { GithubItem } from '@open-mercato/cezar-api-client'
import { IssueOwnership } from './issue-ownership'

afterEach(cleanup)
const issue: GithubItem = { kind: 'issue', number: 42, title: 'Login issue', author: 'ada', createdAt: '2026-10-30T12:00:00Z', labels: [], url: 'https://github.com/owner/repo/issues/42', comments: 4 }
const pr = { number: 80, title: 'Fix login', url: 'https://github.com/owner/repo/pull/80', state: 'open' as const, isDraft: false }

describe('IssueOwnership (#1620)', () => {
  it('keeps legacy/unknown and other-forge payloads neutral, and leaves PR rows unchanged', () => {
    const { container, rerender } = render(<IssueOwnership item={issue} />)
    expect(container.childElementCount).toBe(0)
    rerender(<IssueOwnership item={{ ...issue, kind: 'pr', assignees: ['grace'], linkedPrs: [pr] }} />)
    expect(container.childElementCount).toBe(0)
  })

  it('shows known empty assignees as unassigned without inventing a linked PR', () => {
    render(<IssueOwnership item={{ ...issue, assignees: [], linkedPrs: [] }} />)
    expect(screen.getByText('Unassigned')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('shows multiple assignees and independently accessible authoritative PR links', () => {
    render(<IssueOwnership item={{ ...issue, assignees: ['grace', 'lin'], linkedPrs: [pr] }} />)
    expect(screen.getByText('Assigned to @grace, @lin')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'PR #80 · Open: Fix login' })
    expect(link.getAttribute('href')).toBe(pr.url)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link.parentElement?.closest('a')).toBeNull()
  })

  it.each([
    ['open', true, 'Draft'], ['merged', false, 'Merged'], ['closed', false, 'Closed'],
  ] as const)('distinguishes %s/draft=%s as %s', (state, isDraft, expected) => {
    render(<IssueOwnership item={{ ...issue, linkedPrs: [{ ...pr, state, isDraft }] }} />)
    expect(screen.getByRole('link', { name: `PR #80 · ${expected}: Fix login` })).toBeTruthy()
    expect(screen.queryByText('Unassigned')).toBeNull()
  })

  it('keeps partial connections explicit and links to the issue for more entries', () => {
    render(<IssueOwnership item={{ ...issue, assignees: [], assigneesTruncated: true, linkedPrs: [pr], linkedPrsTruncated: true }} />)
    expect(screen.queryByText('Unassigned')).toBeNull()
    expect(screen.getByRole('link', { name: 'More assignees for issue #42' }).getAttribute('href')).toBe(issue.url)
    expect(screen.getByRole('link', { name: 'More linked pull requests for issue #42' }).getAttribute('href')).toBe(issue.url)
  })

  it('retains long logins/titles without unsafe link schemes', () => {
    const login = 'a'.repeat(200)
    const title = 'Long implementation title '.repeat(30)
    render(<IssueOwnership item={{ ...issue, assignees: [login], linkedPrs: [{ ...pr, title, url: 'javascript:void(0)' }] }} />)
    expect(screen.getByText(`Assigned to @${login}`).parentElement?.getAttribute('title')).toBe(`Assigned to @${login}`)
    expect(screen.getByText('PR #80 · Open')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })
})
