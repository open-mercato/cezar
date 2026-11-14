import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { GlobalInstructionsCard } from './global-instructions-section'

const CONFIG: WorkspaceConfigResponse = {
  branding: { name: 'cezar', logoUrl: null },
  browseRoot: '~/',
  projectsDir: '~/cezar/projects',
  skillsAutoUpdate: null,
  effectiveSkillsAutoUpdate: true,
  orgSkillsRepos: [],
  systemPrompt: 'be brief',
  composerDefaults: { autonomous: null, worktree: null, inheritedAutonomous: 'source-dependent', inheritedWorktree: true },
  resources: {
    maxParallel: 2,
    maxMonitoringSessions: 2,
    idleTimeoutMinutes: 15,
    monitoringWakeIntervalMinutes: null,
    autoResumeOnUsageLimit: true,
    memoryLimitMb: null,
    worktreeRetentionDefault: 10,
  },
  agentDefaults: {},
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Settings → Agents → Global instructions', () => {
  it('says an edit reaches new runs only — a running task keeps the prompt it started with', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
    const client = createQueryClient()
    client.setQueryData(workspaceQueryKeys.config, CONFIG)
    render(
      <QueryClientProvider client={client}>
        <GlobalInstructionsCard />
      </QueryClientProvider>,
    )
    expect(screen.getByText(/Applied to new runs only\./)).toBeTruthy()
  })
})
