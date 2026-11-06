import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiRun, HarnessLedgerResponse } from '@open-mercato/cezar-api-client'
import { HarnessDecisionCard } from './harness-decision-card'

const { request, accept } = vi.hoisted(() => ({ request: vi.fn(), accept: vi.fn() }))
vi.mock('@/api/harness', () => ({
  useHarnessReviewAction: () => ({ mutate: request, isPending: false }),
  useAcceptContestedHarness: () => ({ mutate: accept, isPending: false }),
}))
const run = { id: 'r1', status: 'review', harness: { workflow: 'harness-implement-feature', profile: 'standard' } } as ApiRun
const ledger: HarnessLedgerResponse = {
  version: 2, workflow: 'harness-implement-feature', requestedProfile: 'standard', effectiveProfile: 'standard',
  models: [], invocations: [], pendingMessages: [],
  phases: [{ id: 'implement', name: 'Implement', kind: 'agent', status: 'done', attempts: 1, artifacts: {} }, { id: 'fix-final', name: 'Closing fixes', kind: 'agent', status: 'done', attempts: 1, artifacts: {} }],
  councils: [{ kind: 'implementation', round: 3, verdict: 'request_changes', findings: [{ title: 'Missing tenant guard', severity: 'major', by: 'claude' }] }],
  outcome: { status: 'contested', blockingReasons: ['Missing tenant guard'] }, stage: { status: 'staged' },
  loops: { fixRounds: 3, maxFixRounds: 3 }, actionRevision: 'snapshot',
}
function show(value = ledger, task = run) { return render(<MemoryRouter><HarnessDecisionCard run={task} ledger={value} /></MemoryRouter>) }
beforeEach(() => { request.mockReset(); accept.mockReset(); Element.prototype.scrollIntoView = vi.fn() })
afterEach(cleanup)

describe('guided review decision', () => {
  it('exposes one-pass verification without requiring a note or accepting risk', () => {
    show()
    expect(screen.getByText('Changes saved — verification needed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Verify final fixes' }))
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'verify', revision: 'snapshot' }), expect.anything())
    expect(accept).not.toHaveBeenCalled()
  })
  it('requires a selected concern for the bounded repair and retains finding identity', async () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Inspect findings' }))
    const selected = screen.getByRole('checkbox', { name: /select finding/i })
    expect(screen.getByText(/Fixed, awaiting verification/)).toBeTruthy()
    fireEvent.click(selected)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Fix 0 selected findings' }).disabled).toBe(true)
    fireEvent.click(selected)
    fireEvent.click(screen.getByRole('button', { name: 'Fix 1 selected finding' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'fix', findingIds: [expect.stringMatching(/^finding-/)] }), expect.anything()))
  })
  it('explains unavailable checks as setup work instead of a green validation result', () => {
    show({ ...ledger, environment: { status: 'needs-setup', detail: 'Dependencies missing', installCommand: 'yarn install --immutable', manager: 'yarn' },
      validation: [{ command: 'yarn test', status: 'failed', exitCode: 1, evidence: "Couldn't find the node_modules state file", preexisting: true }] })
    expect(screen.getByText('Project setup needed')).toBeTruthy()
    expect(screen.getByText('1 check could not run. It has not passed.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Prepare project & verify' }))
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'prepare' }), expect.anything())
  })
  it('requires an explicit risk reason and never auto-publishes', () => {
    show()
    expect(screen.queryByLabelText('Reason for accepting contested result')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Accept risk…' }))
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Accept risk and unlock publishing' })
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Reason for accepting contested result'), { target: { value: 'Reviewed and accepted' } })
    fireEvent.click(button)
    expect(accept).toHaveBeenCalledWith('Reviewed and accepted', expect.anything())
    expect(request).not.toHaveBeenCalled()
  })
  it('offers setup when a legacy ready ledger contains unavailable checks', () => {
    show({ ...ledger, outcome: { status: 'ready', blockingReasons: [] }, environment: { status: 'needs-setup', detail: 'Saved checks could not run.', installCommand: 'yarn install --immutable' } })
    expect(screen.getByRole('button', { name: 'Prepare project & verify' })).toBeTruthy()
    expect(screen.queryByText('Review complete — changes ready')).toBeNull()
  })
});
