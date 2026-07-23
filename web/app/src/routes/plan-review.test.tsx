import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'

import type { PendingPlan } from './new-task-plan'
import { PlanReview } from './plan-review'

afterEach(cleanup)

const plan: PendingPlan = {
  task: 'Review provider gating',
  steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
  rationale: '',
  fallback: false,
  images: [],
}

describe('PlanReview provider availability', () => {
  it('disables Start and exposes accessible setup guidance when starting is unavailable', () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <PlanReview
          plan={plan}
          starting={false}
          startAvailable={false}
          startUnavailableReason="Connect an agent provider before starting this plan."
          startUnavailableAction={<a href="/settings/agents#providers">Configure providers</a>}
          onStepsChange={vi.fn()}
          onStart={vi.fn()}
          onDiscard={vi.fn()}
        />
      </QueryClientProvider>,
    )

    const start = screen.getByRole<HTMLButtonElement>('button', { name: 'Start' })
    expect(start.disabled).toBe(true)
    expect(start.getAttribute('aria-describedby')).toBe('plan-start-guidance')
    expect(screen.getByText('Connect an agent provider before starting this plan.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Configure providers' }).getAttribute('href')).toBe(
      '/settings/agents#providers',
    )
  })
})
