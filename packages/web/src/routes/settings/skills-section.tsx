import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PackageCheckIcon } from 'lucide-react'
import { useState } from 'react'

import { putWorkspaceConfig } from '@/api/client'
import { useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type { SetWorkspaceConfigInput, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'

export function SkillsSection() {
  const config = useWorkspaceConfig()

  if (config.isPending) {
    return (
      <p data-slot="skills-settings-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading skill settings…
      </p>
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
  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result, patch) => {
      queryClient.setQueryData(workspaceQueryKeys.config, result)
      // Org repos feed every project's skill catalog — refetch whichever are cached.
      if (patch.orgSkillsRepos) void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('skills') })
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
    <div
      data-slot="skills-settings-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <section data-slot="org-skills-repos" className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            <label htmlFor="org-skills-repo">Organisation skills repositories</label>
          </h2>
          <p className="text-[13px] text-muted-foreground">
            Git repositories whose skills are available in every project, kept up to date from the
            remote. A project's own skills with the same name win. Use <code>owner/name</code>, a git
            URL or a local path; access uses your existing git credentials.
          </p>
        </div>
        {repos.length > 0 && (
          <ul className="flex flex-col gap-1">
            {repos.map((r) => (
              <li
                key={r.repo}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-[13px]"
              >
                <span className="truncate">
                  {r.repo} <span className="text-soft-foreground">@ {r.ref}</span>
                </span>
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
              </li>
            ))}
          </ul>
        )}
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
          <Button type="submit" size="sm" disabled={save.isPending || !repo.trim()}>
            Add repository
          </Button>
        </form>
      </section>
      <section className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              <label htmlFor="skills-auto-update">Update Open Mercato skills automatically</label>
            </h2>
            <p className="text-[13px] text-muted-foreground">
              Checks installed Open Mercato skills in the background and applies available updates. Other
              skills and untracked folders are never changed.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Switch
              id="skills-auto-update"
              data-slot="skills-auto-update"
              checked={config.effectiveSkillsAutoUpdate}
              disabled={save.isPending}
              onCheckedChange={(checked) => save.mutate({ skillsAutoUpdate: checked })}
            />
            <span className="text-[11px] text-soft-foreground">
              {config.effectiveSkillsAutoUpdate ? 'On' : 'Off'}
              {inherited ? ' (default)' : ''}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
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
      </section>
    </div>
  )
}
