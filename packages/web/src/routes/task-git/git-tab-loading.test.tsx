import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiError } from '@/api/client'

import { GitTabLoadError } from './git-tab-loading'

afterEach(cleanup)

describe('GitTabLoadError', () => {
  it('"Back to tasks" goes to the task list — `/` is the Now page', () => {
    render(
      <MemoryRouter>
        <GitTabLoadError tab="changes" error={new ApiError(404, 'not found')} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { name: 'Task not found' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to tasks' }).getAttribute('href')).toBe('/tasks')
  })
})
