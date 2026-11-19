import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PackageCheckIcon } from 'lucide-react'
import { useState } from 'react'

import { putWorkspaceConfig } from '@/api/client'
import { useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type { SetWorkspaceConfigInput, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { LoadingState, SettingsSkeleton } from '@/components/loading-state'
import { CardNote, FormRow, SettingsCard, useSavedFlash } from './form-row'

/** Settings → Agents → Skill repositories: organisation repos and the Open Mercato auto-update. */
export function SkillsCard() {
  const config = useWorkspaceConfig()

  if (config.isPending) {
    return (
      <LoadingState label="Loading skill settings…" data-slot="skills-settings-loading"><SettingsSkeleton /></LoadingState>
    )
  }
  if (config.isError) {
    return (
      <CenteredState
        icon={<PackageCheckIcon />}
        tone="danger"
        title="Skill settings did not load"
        subtitle={config.error.message}
        heading="h2"
      />
    )
  }
  return <SkillsForm config={config.data} />
}

function SkillsForm({ config }: { config: WorkspaceConfigResponse }) {
  const queryClient = useQueryClient()
  const [saved, flash] = useSavedFlash()
  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result, patch) => {
      queryClient.setQueryData(workspaceQueryKeys.config, result)
      // Org repos feed every project's skill catalog — refetch whichever are cached.
      if (patch.orgSkillsRepos) void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('skills') })
      flash()
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const inherited = config.skillsAutoUpdate === null
  const [repo, setRepo] = useState('')
  const [ref, setRef] = useState('main')
  const repos = config.orgSkillsRepos
  const addRepo = () => {
    const next = repo.trim()
    if (!next || repos.some((r) => r.repo === next)) return
    save.mutate({ orgSkillsRepos: [...repos, { repo: next, ref: ref.trim() || 'main' }] }, { onSuccess: () => setRepo('') })
  }
  return (
    <SettingsCard slot="skills-settings-section" title="Skill repositories">
      <div data-slot="org-skills-repos" className="flex flex-col divide-y divide-border">
        {repos.map((r) => (
          <FormRow
            key={r.repo}
            slot="org-skills-repo"
            label={
              <span className="flex items-center gap-2">
                {r.repo}
                <Badge variant="ghost" className="font-mono text-micro text-muted-foreground">{r.ref}</Badge>
              </span>
            }
            description="Skills from this repository are available in every project."
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove ${r.repo}`}
              disabled={save.isPending}
              onClick={() => save.mutate({ orgSkillsRepos: repos.filter((x) => x.repo !== r.repo) })}
            >
              Remove
            </Button>
          </FormRow>
        ))}
        <FormRow
          stacked
          htmlFor="org-skills-repo"
          label="Organisation skills repositories"
          description={
            <>
              Git repositories whose skills are available in every project, kept up to date from the
              remote. A project's own skills with the same name win. Use <code>owner/name</code>, a git
              URL or a local path; access uses your existing git credentials.
            </>
          }
        >
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              addRepo()
            }}
          >
            <Input
              id="org-skills-repo"
              className="min-w-48 flex-1"
              placeholder="my-org/skills"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
            />
            <Input
              aria-label="Branch or ref"
              className="w-28"
              placeholder="main"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
            />
            <Button type="submit" variant="outline" size="sm" disabled={save.isPending || !repo.trim()}>
              Add repository
            </Button>
          </form>
        </FormRow>
      </div>
      <FormRow
        htmlFor="skills-auto-update"
        saved={saved}
        label="Update Open Mercato skills automatically"
        description={
          <>
            Checks installed Open Mercato skills in the background and applies available updates. Other
            skills and untracked folders are never changed.{' '}
            <span data-slot="skills-auto-update-state">
              {config.effectiveSkillsAutoUpdate ? 'On' : 'Off'}
              {inherited ? ' (default)' : ''}
            </span>
          </>
        }
      >
        <Switch
          id="skills-auto-update"
          data-slot="skills-auto-update"
          checked={config.effectiveSkillsAutoUpdate}
          disabled={save.isPending}
          onCheckedChange={(checked) => save.mutate({ skillsAutoUpdate: checked })}
        />
      </FormRow>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-meta text-soft-foreground">
        <span>
          {inherited
            ? 'No override is saved. CEZ_SKILLS_AUTO_UPDATE supplies the inherited default when set; otherwise it is on.'
            : 'An explicit workspace override is saved.'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-action="skills-use-default"
          disabled={inherited || save.isPending}
          onClick={() => save.mutate({ skillsAutoUpdate: null })}
        >
          Use default
        </Button>
      </div>
      {repos.length === 0 ? null : <CardNote>A project's own skill of the same name wins over a repository's.</CardNote>}
    </SettingsCard>
  )
}
