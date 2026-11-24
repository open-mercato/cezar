import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PackageCheckIcon } from 'lucide-react'
import { useState } from 'react'

import { putWorkspaceConfig } from '@/api/client'
import { queryKeys, useAgentProfiles, useRefreshSkillCatalog, useSkills, useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import { agentAccountRouteId, type SetWorkspaceConfigInput, type WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { LoadingState, SettingsSkeleton } from '@/components/loading-state'
import { PROVIDER_LABEL } from './accounts-section'
import { CardNote, FormRow, SettingsCard, useSavedFlash } from './form-row'

/** Settings → Agents → Skill repositories. */
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
              Git repositories whose skills are available in every project. Use <code>owner/name</code>, a git
              URL or a local path with your existing git credentials.
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
      <AccountSkillAvailability />
    </SettingsCard>
  )
}

const OPEN_MERCATO_REPO = /^(?:(?:https?:\/\/|(?:ssh:\/\/)?git@)github\.com[/:])?open-mercato\/skills(?:\.git)?\/?$/i

function AccountSkillAvailability() {
  const accounts = useAgentProfiles()
  const skills = useSkills()
  const catalogProject = queryKeys.skills[0] === 'default' ? 'the default project' : 'this project'
  const refresh = useRefreshSkillCatalog()

  // Local catalog entries don't carry repository metadata. Open Mercato's om- names also
  // identify local definitions and extension entries whose shared body couldn't be loaded.
  const openMercato = (skills.isSuccess ? skills.data : []).filter(
    (skill) => !skill.kind && (skill.name.startsWith('om-') || OPEN_MERCATO_REPO.test(skill.team?.repo ?? '')),
  )
  const missing = openMercato.filter((skill) => skill.missingShared).map((skill) => skill.name)
  const available = openMercato.length - missing.length
  let status = 'No skills available'
  if (skills.isPending) status = 'Checking skill catalog…'
  else if (skills.isError) status = 'Availability unknown'
  else if (available > 0 && missing.length > 0) status = `${available} available · ${missing.length} missing`
  else if (available === 1) status = '1 skill available'
  else if (available > 1) status = `${available} skills available`

  let catalogError: string | undefined
  if (refresh.isError) catalogError = `Could not repair the skill catalog. ${refresh.error.message}`
  else if (skills.isError) catalogError = `Could not load the skill catalog. ${skills.error.message}`

  return (
    <section aria-label="Open Mercato skills for agent accounts" className="divide-y divide-border">
      <FormRow
        label="Open Mercato skills for agent accounts"
        description={`Tasks for these accounts use ${catalogProject}’s skill catalog.`}
      >
        <Button type="button" variant="outline" size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          {refresh.isPending ? 'Repairing skill catalog…' : 'Repair skill catalog'}
        </Button>
      </FormRow>
      {catalogError ? <CardNote tone="danger"><span role="alert">{catalogError}</span></CardNote> : null}
      {refresh.isSuccess && skills.isSuccess ? (
        <CardNote>
          <span role="status">
            Catalog refreshed.
            {available === 0 ? ' No Open Mercato skills are available.' : null}
            {available > 0 && missing.length > 0 ? ' Some shared skills are still missing.' : null}
          </span>
        </CardNote>
      ) : null}
      {accounts.isPending ? <CardNote><span role="status">Loading agent accounts…</span></CardNote> : null}
      {accounts.isError ? (
        <CardNote tone="danger"><span role="alert">Could not load agent accounts. {accounts.error.message}</span></CardNote>
      ) : null}
      {accounts.isSuccess && accounts.data.profiles.length === 0 ? (
        <CardNote>
          {accounts.data.editable ? 'No agent accounts found.' : 'Account details are hidden on this cockpit.'} {status}
        </CardNote>
      ) : null}
      {accounts.isSuccess && accounts.data.profiles.length > 0 ? (
        <ul className="divide-y divide-border">
          {accounts.data.profiles.map((account) => (
            <li key={agentAccountRouteId(account)}>
              <FormRow
                label={account.label}
                description={PROVIDER_LABEL[account.provider] + (account.isDefault ? ' · Discovered' : '')}
              >
                <span className="text-meta text-muted-foreground">{status}</span>
              </FormRow>
            </li>
          ))}
        </ul>
      ) : null}
      {missing.length > 0 ? <CardNote>The catalog is missing shared skills for {missing.join(', ')}.</CardNote> : null}
    </section>
  )
}
