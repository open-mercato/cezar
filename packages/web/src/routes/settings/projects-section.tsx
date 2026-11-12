import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FoldersIcon, XIcon } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link as RouterLink } from 'react-router'

import { putWorkspaceConfig } from '@/api/client'
import {
  useProjects,
  useRegisterProject,
  useUpdateProject,
  useWorkspaceConfig,
  workspaceQueryKeys,
} from '@/api/queries'
import {
  PROJECT_TAGS_MAX,
  PROJECT_TAG_MAX_LENGTH,
  type ProjectListEntry,
  type ProjectsResponse,
  type WorkspaceConfigResponse,
} from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { IntegerStepper } from '@/components/integer-stepper'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { toast } from '@/components/ui/toaster'
import { LoadingState, SettingsSkeleton } from '@/components/loading-state'
import { allProjectTags, suggestTags } from '@/lib/project-tags'
import { cn } from '@/lib/utils'
import { CardNote, FormRow, SettingsCard, isCommitKey, useSavedFlash } from './form-row'
import { RemoveProjectDialog, useProjectRemoval } from './remove-project'

/**
 * Settings → Projects (multi-project spec, step 4.4; design doc Proposal 8): the two things
 * that describe the WORKSPACE rather than any one repo — where "Clone from GitHub" puts new
 * checkouts, and the registry itself.
 *
 * Two deliberate decisions live here:
 *
 * 1. **The checkout-root error is the server's, verbatim.** Writability is decided by the
 *    `PUT /api/workspace/config` probe (step 2.7: `mkdir -p`, `access W_OK`, then a real
 *    create/delete round-trip, because W_OK alone lies on a read-only mount). The client cannot
 *    reproduce that from a browser and must not pretend to: this pane renders the 400's `{ error }`
 *    string inline under the field ("not writable: …"), never a generic "invalid path".
 *
 * 2. **Remove only ever DEREGISTERS.** No files are deleted, ever — not the repo, not its tasks,
 *    not its worktrees (`DELETE /api/projects/:id` is a registry filter; see the route). A
 *    project with running tasks is refused server-side with a 409, surfaced as a toast.
 *
 * The table gives the Name column the width (the one column a reader needs); the per-project
 * task cap lives on the project's own General page, where it is acted on in context.
 */

/** Which project the confirm dialog is about — `null` while it is closed. */
type Confirming = ProjectListEntry | null

/** Per-project concurrency bounds — mirror the workspace cap (resources-section.tsx). */
const MAX_PARALLEL_MIN = 1
const MAX_PARALLEL_MAX = 16

/** Human wording for a registry status probe. `not-git` is fully usable (single-queue
 *  degraded mode), so it reads as a note rather than a fault; only `missing` is a problem.
 *  Exported because the project's own General page states the same status about itself. */
export const STATUS_LABEL: Record<ProjectListEntry['status'], string> = {
  ok: 'ok',
  'not-git': 'no git repo',
  missing: 'folder not found',
}

/** `2026-07-20T…` → `Jul 20`, in the reader's locale. Registry timestamps are ISO strings; an
 *  unparseable one (hand-edited config) degrades to an em dash rather than `Invalid Date`. */
function shortDate(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function ProjectsSection() {
  const config = useWorkspaceConfig()
  const projects = useProjects()

  if (config.isPending || projects.isPending) {
    return (
      <LoadingState label="Loading projects…" data-slot="projects-loading"><SettingsSkeleton /></LoadingState>
    )
  }
  if (config.isError || projects.isError) {
    return (
      <CenteredState
        icon={<FoldersIcon />}
        tone="danger"
        title="Project settings did not load"
        subtitle={(config.error ?? projects.error)?.message}
        heading="h2"
      />
    )
  }
  return <ProjectsPane config={config.data} registry={projects.data} />
}

function ProjectsPane({
  config,
  registry,
}: {
  config: WorkspaceConfigResponse
  registry: ProjectsResponse
}) {
  return (
    <div data-slot="projects-section" className="flex w-full flex-col gap-5">
      <SettingsCard id="folders" title="Folders">
        <WorkspaceRootField
          configKey="browseRoot"
          value={config.browseRoot}
          title="Default browse folder"
          hint="Where “Open local folder…” starts; the picker cannot navigate above it. Verified writable before saving. Only affects folder browsing — GitHub checkouts use the checkout folder."
          placeholder="~/"
          slot="browse"
        />
        <WorkspaceRootField
          configKey="projectsDir"
          value={config.projectsDir}
          title="Default checkout folder"
          hint="Where “Clone from GitHub” and “New project” put new projects: <folder>/<project name>. Created if needed and verified writable before saving. Projects already registered keep their location."
          placeholder="~/cezar/projects"
          slot="checkout"
          refreshProjects
        />
      </SettingsCard>
      <RegistryTable registry={registry} />
    </div>
  )
}

/** A workspace folder — saved on blur or Enter, validated by the SERVER. */
function WorkspaceRootField({
  configKey,
  value: configuredValue,
  title,
  hint,
  placeholder,
  slot,
  refreshProjects = false,
}: {
  configKey: 'browseRoot' | 'projectsDir'
  value: string
  title: string
  hint: string
  placeholder: string
  slot: 'browse' | 'checkout'
  refreshProjects?: boolean
}) {
  const queryClient = useQueryClient()
  const [saved, flash] = useSavedFlash()
  // The merged config the PUT answers with lands straight in the workspace-config query. The
  // projects response carries projectsDir for the clone dialog, while every fs-browse result is
  // relative to browseRoot. Invalidate the corresponding authoritative cache after either save.
  const save = useMutation({
    mutationFn: (next: string) =>
      putWorkspaceConfig(configKey === 'browseRoot' ? { browseRoot: next } : { projectsDir: next }),
    onSuccess: (result) => {
      queryClient.setQueryData(workspaceQueryKeys.config, result)
      if (configKey === 'browseRoot') {
        void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.fsBrowseRoot })
      } else if (refreshProjects) {
        void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects })
      }
      flash()
    },
  })
  const [value, setValue] = useState(configuredValue)
  const trimmed = value.trim()
  const unchanged = trimmed === configuredValue
  // The 400's message ("not writable: …"), shown until the next attempt — passed through
  // untouched, because paraphrasing "permission denied on /opt/checkouts" as "invalid path"
  // throws away the only sentence that tells the user what to fix.
  const serverError = save.isError ? save.error.message : null
  const commit = () => {
    if (unchanged || trimmed === '' || save.isPending) return
    save.mutate(trimmed)
  }
  const id = `projects-${slot}-root`

  return (
    <FormRow
      htmlFor={id}
      saved={saved}
      label={title}
      description={
        serverError !== null ? (
          // The reason, then what did NOT happen — a failed probe persists nothing, and saying
          // so stops the reader wondering which value is live.
          <span data-slot={`${id}-error`} role="alert" className="text-danger">
            {serverError} — setting unchanged
          </span>
        ) : (
          hint
        )
      }
    >
      <input
        id={id}
        type="text"
        spellCheck={false}
        aria-invalid={serverError !== null}
        data-slot={id}
        value={value}
        disabled={save.isPending}
        placeholder={placeholder}
        onChange={(event) => {
          setValue(event.target.value)
          // Editing clears the stale failure: the message names a path that is no longer in
          // the field, so leaving it up would be a lie about the current value.
          if (save.isError) save.reset()
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (isCommitKey(event)) {
            event.preventDefault()
            commit()
          }
        }}
        className="block w-full max-w-xs rounded-md border border-input bg-card px-3 py-1.5 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-danger disabled:opacity-50"
      />
    </FormRow>
  )
}

function RegistryTable({ registry }: { registry: ProjectsResponse }) {
  const [confirming, setConfirming] = useState<Confirming>(null)
  const remove = useProjectRemoval()
  // One computation for the whole table: the vocabulary is a property of the WORKSPACE, and
  // every row's autocomplete offers the same list.
  const vocabulary = useMemo(() => allProjectTags(registry.projects), [registry.projects])

  const confirmRemoval = () => {
    if (!confirming) return
    const project = confirming
    setConfirming(null)
    remove.confirm(project)
  }

  return (
    <SettingsCard id="registry" title="Registered projects">
      {/* Defensive: `GET /api/v1/projects` names at least the folder this server is serving
          whenever the registry is empty (the unregistered row), so today this branch cannot
          render. Kept because an empty table would be a worse answer than a sentence. */}
      {registry.projects.length === 0 ? (
        <CardNote slot="projects-empty">No projects registered yet.</CardNote>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-ui">
            {/* Not "registered": this table also renders the folder cezar is serving without
                having saved it, whose only action is Add project. */}
            <caption className="sr-only">Projects in this workspace</caption>
            {/* The Name column takes whatever the fixed columns leave: it is the one a reader
                needs, and it must never truncate to three letters again. */}
            <colgroup>
              <col />
              <col style={{ width: '112px' }} />
              <col style={{ width: '180px' }} />
              <col style={{ width: '72px' }} />
              <col style={{ width: '150px' }} />
            </colgroup>
            <thead>
              <tr className="border-b border-border text-left text-label text-soft-foreground">
                <th scope="col" className="px-4 py-2 font-medium">Project</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 font-medium">Tags</th>
                <th scope="col" className="px-3 py-2 font-medium">Added</th>
                <th scope="col" className="px-3 py-2 text-right font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {registry.projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  isBoot={project.id === registry.bootProject}
                  vocabulary={vocabulary}
                  disabled={remove.isPending}
                  onRemove={() => setConfirming(project)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CardNote>
        Tags group connected repositories — give the API, the web app and the design system a shared
        “storefront” tag and the global Tasks page can show all three as one piece of work. A project's
        task cap lives on its General page. Removing a project only unregisters it — no files on disk
        are deleted.
      </CardNote>

      <RemoveProjectDialog
        project={confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
        onConfirm={confirmRemoval}
      />
    </SettingsCard>
  )
}

function ProjectRow({
  project,
  isBoot,
  vocabulary,
  disabled,
  onRemove,
}: {
  project: ProjectListEntry
  isBoot: boolean
  vocabulary: readonly string[]
  disabled: boolean
  onRemove: () => void
}) {
  return (
    <tr data-slot="project-row" data-project={project.id} className="border-b border-border last:border-0">
      <th scope="row" className="min-w-0 px-4 py-2 text-left font-normal">
        <span data-slot="project-name" className="block truncate text-foreground" title={project.name}>{project.name}</span>
        <span className="block truncate font-mono text-meta text-soft-foreground" title={project.root}>
          {project.root}
        </span>
      </th>
      <td className="px-3 py-2">
        <span
          data-slot="project-status"
          className={project.status === 'missing' ? 'text-label text-danger' : 'text-label text-soft-foreground'}
        >
          {STATUS_LABEL[project.status]}
        </span>
        {project.unregistered ? (
          // Where `source` (how it got into the registry) would go — it is not in the registry,
          // and this is the row's whole story, so it says that instead.
          <span data-slot="project-unregistered" className="block text-meta text-soft-foreground">
            not registered
          </span>
        ) : project.status !== 'missing' ? (
          <span className="block text-meta text-soft-foreground">{project.source}</span>
        ) : null}
      </td>
      <td className="px-3 py-2">
        {/* Every registry edit is meaningless for a folder that has no registry row: tags are
            stored ON the entry, and Remove would 404. */}
        {project.unregistered ? (
          <span className="text-label text-soft-foreground">—</span>
        ) : (
          <ProjectTagsEditor project={project} vocabulary={vocabulary} />
        )}
      </td>
      <td className="px-3 py-2 tabular-nums text-soft-foreground">
        {project.unregistered ? '—' : shortDate(project.addedAt)}
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        {/* Into the project's own settings (unified settings, spec 2026-10-13). An EXPLICIT
            `/p/<id>` path — this pane renders outside every project scope, so the scoped Link
            would have nothing to prefix with. Neither a missing project (its panes all 409) nor
            the unregistered launch folder (not a project) gets one. */}
        {!project.unregistered && project.status !== 'missing' ? (
          <Button asChild variant="ghost" size="sm">
            <RouterLink
              to={`/p/${encodeURIComponent(project.id)}/settings`}
              data-action="project-settings"
              aria-label={`Settings for ${project.name}`}
            >
              Settings
            </RouterLink>
          </Button>
        ) : null}
        {project.unregistered ? (
          <AddBootProjectButton
            root={project.root}
            name={project.name}
            disabled={disabled}
            notAddable={project.notAddable === true}
          />
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-action="project-remove"
            // Leads with the button's own word (WCAG 2.5.3 Label in Name), then says what
            // "Remove" actually does — the row context isn't read out with the control.
            aria-label={`Remove ${project.name} from the workspace — unregisters it, no files are deleted`}
            // The boot project is refused server-side too (this server runs out of it);
            // disabling here means the user gets the explanation before the click, not after.
            title={isBoot ? 'cezar is serving this project — stop it and use `cezar projects remove`' : undefined}
            disabled={disabled || isBoot}
            onClick={onRemove}
          >
            Remove
          </Button>
        )}
      </td>
    </tr>
  )
}

/**
 * The one gesture an unregistered boot row can offer: save the folder cezar is currently serving.
 * It goes through the ordinary `POST /api/v1/projects` — same guards, same 409 on a folder
 * already registered — so a root the server refuses (`$HOME`, a task worktree) answers with its
 * own explanation and this button surfaces it verbatim.
 *
 * Exported for the project's own General page, which faces the same row and must not invent a
 * second way to say this — the same reason `MaxParallelStepper` and `STATUS_LABEL` are shared.
 */
export function AddBootProjectButton({
  root,
  name,
  disabled = false,
  notAddable = false,
}: {
  root: string
  name: string
  disabled?: boolean
  /** The server refuses this folder (`$HOME`, a task worktree): explain instead of 400-ing. */
  notAddable?: boolean
}) {
  const register = useRegisterProject()
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-action="project-add-boot"
      aria-label={`Add ${name} to your projects`}
      title={
        notAddable
          ? 'Your home directory or a cezar task worktree cannot be a project — start cezar in a project folder, or use Open local folder'
          : 'cezar is serving this folder — save it to your projects'
      }
      disabled={disabled || notAddable || register.isPending}
      onClick={() =>
        register.mutate(root, {
          onSuccess: () => toast(`${name} added to your projects`),
          onError: (error: Error) => toast(error.message, { tone: 'danger' }),
        })
      }
    >
      Add project
    </Button>
  )
}

/**
 * Per-project tags — the labels that group CONNECTED repositories.
 *
 * The point is cross-repo work: tag the API, the web app and the design system `storefront` and
 * the global Tasks page (`/tasks`) can show all three as one list. Nothing else in cezar reads
 * them, deliberately — a tag is a lens, not a permission, a queue or a routing rule.
 *
 * Bound to the server value with no local mirror of the list: the chips render `project.tags`
 * and every gesture sends the WHOLE new list through `PATCH /api/projects/:id`, whose answer the
 * hook invalidates the registry with. The only local state is the text being typed.
 *
 * Committing on Enter AND on comma, because both are what people type; blur does NOT commit, on
 * purpose — tabbing out of a half-typed word should not persist it.
 *
 * The field AUTOCOMPLETES from the tags already used anywhere in the registry: tags only group
 * anything if two projects spell one the same way, and free text does not converge on its own.
 */
export function ProjectTagsEditor({
  project,
  vocabulary,
}: {
  project: ProjectListEntry
  /** Every tag already in use ANYWHERE in the registry — the autocomplete list. */
  vocabulary: readonly string[]
}) {
  const update = useUpdateProject()
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  // Which suggestion the arrow keys are on; -1 = none, and Enter then commits the typed text.
  const [highlight, setHighlight] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const tags = project.tags ?? []
  const suggestions = suggestTags(vocabulary, tags, draft)
  const listOpen = open && suggestions.length > 0

  const save = (next: string[], message: string) => {
    update.mutate(
      { id: project.id, tags: next },
      {
        onSuccess: () => toast(message),
        onError: (error: Error) => toast(error.message, { tone: 'danger' }),
      },
    )
  }

  const add = (raw: string) => {
    const tag = raw.trim().slice(0, PROJECT_TAG_MAX_LENGTH)
    setHighlight(-1)
    if (!tag) return
    // Refused locally rather than sent and bounced: the server would normalize the duplicate
    // away and answer 200, which would look like it worked and quietly do nothing.
    if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      setDraft('')
      return
    }
    if (tags.length >= PROJECT_TAGS_MAX) {
      toast(`${project.name} already has the maximum of ${PROJECT_TAGS_MAX} tags`, { tone: 'danger' })
      return
    }
    setDraft('')
    save([...tags, tag], `${project.name} tagged “${tag}”`)
  }

  const remove = (tag: string) => {
    save(
      tags.filter((existing) => existing !== tag),
      `“${tag}” removed from ${project.name}`,
    )
  }

  const listId = `project-tag-suggestions-${project.id}`

  return (
    <div data-slot="project-tags" className="flex flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          data-slot="project-tag"
          // `whitespace-nowrap`: a hyphenated tag (`open-mercato`) was wrapping mid-word into a
          // two-line chip, which read as two tags.
          className="inline-flex max-w-full items-center gap-1 rounded-full bg-violet/15 py-px pr-1 pl-2 text-meta font-medium whitespace-nowrap text-violet"
        >
          {tag}
          <button
            type="button"
            data-action="project-tag-remove"
            aria-label={`Remove tag ${tag} from ${project.name}`}
            disabled={update.isPending}
            onClick={() => remove(tag)}
            className="rounded-full p-0.5 hover:bg-violet/25 disabled:opacity-50"
          >
            <XIcon className="size-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      {/* A Radix popover rather than an absolutely-positioned div: the registry table sits inside
          `overflow-x-auto`, which would clip an in-flow dropdown. The content is portalled, so it
          escapes that box; the input stays the anchor and keeps focus throughout. */}
      <Popover open={listOpen} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <input
            ref={inputRef}
            type="text"
            data-slot="project-tag-input"
            aria-label={`Add a tag to ${project.name}`}
            // Combobox semantics, hand-wired because the listbox is a sibling rather than a
            // child: a screen reader needs to know this input owns a list and which row is active.
            role="combobox"
            aria-expanded={listOpen}
            aria-controls={listOpen ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              listOpen && highlight >= 0 ? `${listId}-${highlight}` : undefined
            }
            placeholder={tags.length === 0 ? 'Add tag…' : '+'}
            value={draft}
            maxLength={PROJECT_TAG_MAX_LENGTH}
            disabled={update.isPending}
            onFocus={() => setOpen(true)}
            // Safe BECAUSE the suggestion buttons commit on `mousedown` with the default
            // prevented: picking one never moves focus, so a real blur always means "left the
            // field". This is the only thing that closes the list on an outside click.
            onBlur={() => setOpen(false)}
            onChange={(event) => {
              setOpen(true)
              setHighlight(-1)
              // A comma is a separator everywhere else tags are typed.
              if (event.target.value.includes(',')) {
                setDraft(event.target.value.replace(/,/g, ''))
                return
              }
              setDraft(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                if (suggestions.length === 0) return
                event.preventDefault()
                setOpen(true)
                const step = event.key === 'ArrowDown' ? 1 : -1
                // Wraps through -1, which is "the text I typed".
                const next = highlight + step
                setHighlight(next >= suggestions.length ? -1 : next < -1 ? suggestions.length - 1 : next)
                return
              }
              if (event.key === 'Escape' && listOpen) {
                // Closes the list only. The draft survives.
                event.preventDefault()
                setOpen(false)
                setHighlight(-1)
                return
              }
              if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault()
                add(highlight >= 0 ? (suggestions[highlight] ?? draft) : draft)
                return
              }
              if (event.key === 'Tab') {
                setOpen(false)
                return
              }
              // Backspace on an empty field deletes the last chip — the standard token-field gesture.
              if (event.key === 'Backspace' && draft === '' && tags.length > 0) {
                event.preventDefault()
                const last = tags[tags.length - 1]
                if (last !== undefined) remove(last)
              }
            }}
            className="h-6 w-16 min-w-0 flex-1 rounded-md border border-input bg-card px-1.5 text-label outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          sideOffset={4}
          id={listId}
          role="listbox"
          data-slot="project-tag-suggestions"
          className="w-56 p-1"
          // Focus never leaves the input: this list is an accessory to it, not a place to be.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          // THE fix for "the list blinks and vanishes on click": the list opens on the input's
          // `focus`, and Radix's DismissableLayer saw that very focus as an outside interaction.
          // The thing being focused is deliberately outside the layer, so the layer stops owning
          // dismissal and this component does — `onBlur`, Escape, Tab, and picking a suggestion.
          onInteractOutside={(event) => event.preventDefault()}
        >
          <p className="px-2 pt-1 pb-1.5 text-micro text-soft-foreground">
            Tags used in this workspace
          </p>
          {suggestions.map((tag, index) => (
            <button
              key={tag}
              type="button"
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlight}
              data-slot="project-tag-suggestion"
              // `onMouseDown` + preventDefault so the press never blurs the input first.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                add(tag)
                inputRef.current?.focus()
              }}
              onMouseEnter={() => setHighlight(index)}
              className={cn(
                'flex w-full items-center rounded-sm px-2 py-1 text-left text-label font-medium text-violet',
                index === highlight && 'bg-muted',
              )}
            >
              {tag}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  )
}

/**
 * Per-project "Max parallel tasks" stepper (spec 2026-07-22), on the project's General page. An
 * empty field is the unset default — it inherits the workspace limit, which the placeholder
 * names; `1..16` pins a per-project ceiling. Bound to the server value and saved on commit; a
 * failed save reverts to the server's value, and the hook invalidates the projects query.
 */
export function MaxParallelStepper({
  project,
  workspaceMax,
  onSaved,
}: {
  project: ProjectListEntry
  workspaceMax: number
  onSaved?: () => void
}) {
  const update = useUpdateProject()
  return (
    <IntegerStepper
      aria-label={`Max parallel tasks for ${project.name}`}
      data-slot="project-max-parallel"
      value={project.maxParallel ?? null}
      min={MAX_PARALLEL_MIN}
      max={MAX_PARALLEL_MAX}
      allowEmpty
      emptyStepFrom={Math.min(MAX_PARALLEL_MAX, Math.max(MAX_PARALLEL_MIN, workspaceMax))}
      placeholder={`Inherit (${workspaceMax})`}
      className="w-40"
      onCommit={(next) =>
        update.mutateAsync(
          { id: project.id, maxParallel: next },
          {
            onSuccess: () => {
              onSaved?.()
              toast(
                next === null
                  ? `${project.name} inherits the workspace limit (${workspaceMax})`
                  : `${project.name} runs at most ${next} task${next === 1 ? '' : 's'} at a time`,
              )
            },
            onError: (error: Error) => toast(error.message, { tone: 'danger' }),
          },
        )
      }
    />
  )
}
