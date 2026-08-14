import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FoldersIcon, XIcon } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { putWorkspaceConfig } from '@/api/client'
import {
  useProjects,
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
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { toast } from '@/components/ui/toaster'
import { allProjectTags, suggestTags } from '@/lib/project-tags'
import { cn } from '@/lib/utils'
import { RemoveProjectDialog, useProjectRemoval } from './remove-project'
import { SettingsField } from './settings-field'

/**
 * Global settings → Projects (multi-project spec, step 4.4; mockup
 * `settings-global.html`): the two things that describe the WORKSPACE rather than any one repo —
 * where "Clone from GitHub" puts new checkouts, and the registry itself.
 *
 * Two deliberate decisions live here:
 *
 * 1. **The checkout-root error is the server's, verbatim.** Writability is decided by the
 *    `PUT /api/workspace/config` probe (step 2.7: `mkdir -p`, `access W_OK`, then a real
 *    create/delete round-trip, because W_OK alone lies on a read-only mount). The client cannot
 *    reproduce that from a browser and must not pretend to: this pane renders the 400's `{ error }`
 *    string inline under the field ("not writable: …"), never a generic "invalid path". The one
 *    thing checked locally is emptiness, because an empty field isn't a request worth sending.
 *
 * 2. **Remove only ever DEREGISTERS.** No files are deleted, ever — not the repo, not its tasks,
 *    not its worktrees (`DELETE /api/projects/:id` is a registry filter; see the route). The
 *    button, the confirm title, the confirm body and the section hint all say so, because
 *    "Remove" next to a project path is exactly the kind of button a user reads as "delete my
 *    repo". A project with running tasks is refused server-side with a 409, whose message this
 *    pane surfaces as a toast.
 *
 * The `missing` row (a registered folder that has been deleted or moved) is why the remove
 * affordance lives here rather than in the sidebar: the sidebar greys it out, this is where the
 * user can act on it.
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
      <p data-slot="projects-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading projects…
      </p>
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
    <div
      data-slot="projects-section"
      // `max-w-4xl`, not the `max-w-2xl` the other settings panes use: this is the one section
      // whose content is a six-column TABLE rather than a stack of form fields, and 2xl left the
      // Tags cell narrow enough to break `open-mercato` across two lines. The fields above keep
      // their own `max-w-sm`, so widening the column costs them nothing.
      className="mx-auto flex w-full max-w-4xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <WorkspaceRootField
        configKey="browseRoot"
        value={config.browseRoot}
        title="Default browse folder"
        hint="Where “Open local folder…” starts. The picker cannot navigate above this folder."
        placeholder="~/"
        slot="browse"
        savedLabel="Browse folder"
        footer="Only affects folder browsing; GitHub checkouts use the separate checkout folder."
      />
      <WorkspaceRootField
        configKey="projectsDir"
        value={config.projectsDir}
        title="Default checkout folder"
        hint="Where “Clone from GitHub” puts new projects: <folder>/<project name>."
        placeholder="~/cezar/projects"
        slot="checkout"
        savedLabel="Checkout folder"
        footer="Only affects new checkouts; projects already registered keep their location."
        refreshProjects
      />
      <RegistryTable registry={registry} workspaceMax={config.resources.maxParallel} />
    </div>
  )
}

/** A workspace folder — edited locally, saved explicitly, and validated by the SERVER. */
function WorkspaceRootField({
  configKey,
  value: configuredValue,
  title,
  hint,
  placeholder,
  slot,
  savedLabel,
  footer,
  refreshProjects = false,
}: {
  configKey: 'browseRoot' | 'projectsDir'
  value: string
  title: string
  hint: string
  placeholder: string
  slot: 'browse' | 'checkout'
  savedLabel: string
  footer: string
  refreshProjects?: boolean
}) {
  const queryClient = useQueryClient()
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
    },
  })
  const [value, setValue] = useState(configuredValue)
  const trimmed = value.trim()
  const unchanged = trimmed === configuredValue
  // The 400's message ("not writable: …"), shown until the next attempt. `save.error` is the
  // ApiError `errorFor` built from the server's own `{ error }` — passed through untouched,
  // because paraphrasing "permission denied on /opt/checkouts" as "invalid path" throws away
  // the only sentence that tells the user what to fix.
  const serverError = save.isError ? save.error.message : null

  return (
    <SettingsField
      title={title}
      hint={`${hint} ${
        configKey === 'browseRoot'
          ? 'Choose an existing folder; it is verified writable before saving.'
          : 'The folder is created recursively if needed, then verified writable before saving.'
      }`}
    >
      <div className="flex items-center gap-2">
        <input
          type="text"
          spellCheck={false}
          aria-label={title}
          aria-invalid={serverError !== null}
          data-slot={`projects-${slot}-root`}
          value={value}
          disabled={save.isPending}
          placeholder={placeholder}
          onChange={(event) => {
            setValue(event.target.value)
            // Editing clears the stale failure: the message names a path that is no longer in
            // the field, so leaving it up would be a lie about the current value.
            if (save.isError) save.reset()
          }}
          className="block w-full max-w-sm rounded-md border border-input bg-card px-3 py-1.5 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-danger disabled:opacity-50"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-action={`projects-save-${slot}-root`}
          disabled={unchanged || trimmed === '' || save.isPending}
          onClick={() =>
            save.mutate(trimmed, { onSuccess: () => toast(`${savedLabel} set to ${trimmed}`) })
          }
        >
          Save
        </Button>
      </div>
      {serverError !== null ? (
        // The mockup's error line: the reason, then what did NOT happen — a failed probe
        // persists nothing, and saying so stops the reader wondering which value is live.
        <p data-slot={`projects-${slot}-root-error`} role="alert" className="text-[11px] text-danger">
          {serverError} — setting unchanged
        </p>
      ) : (
        <p className="text-[11px] text-soft-foreground">
          {footer}
        </p>
      )}
    </SettingsField>
  )
}

function RegistryTable({
  registry,
  workspaceMax,
}: {
  registry: ProjectsResponse
  workspaceMax: number
}) {
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
    <SettingsField
      title="Registered projects"
      hint={`Every folder cezar has run in, plus the ones added from the GUI. “Tags” group connected repositories — give the API, the web app and the design system a shared “storefront” tag and the global Tasks page can show all three as one piece of work. “Max parallel” caps how many of that project's tasks run at once; the workspace limit (${workspaceMax}) still applies as an overall ceiling, so a per-project value above it has no extra effect until the workspace limit is raised. Removing a project only unregisters it — no files on disk are deleted.`}
    >
      {registry.projects.length === 0 ? (
        <p data-slot="projects-empty" className="text-[13px] text-soft-foreground">
          No projects registered yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Projects registered in this workspace</caption>
            {/* Explicit widths rather than letting the browser distribute them by content: Tags
                is the one cell whose content GROWS with use, and auto-layout kept giving it
                whatever the fixed-size controls left over — which was not enough for one chip. */}
            <colgroup>
              <col />
              <col style={{ width: '104px' }} />
              <col style={{ width: '260px' }} />
              <col style={{ width: '150px' }} />
              <col style={{ width: '72px' }} />
              <col style={{ width: '92px' }} />
            </colgroup>
            <thead>
              <tr className="border-b border-border text-left text-[12px] text-soft-foreground">
                <th scope="col" className="px-3 py-2 font-medium">Project</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 font-medium">Tags</th>
                <th scope="col" className="px-3 py-2 font-medium">Max parallel</th>
                <th scope="col" className="px-3 py-2 font-medium">Added</th>
                <th scope="col" className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {registry.projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  isBoot={project.id === registry.bootProject}
                  workspaceMax={workspaceMax}
                  vocabulary={vocabulary}
                  disabled={remove.isPending}
                  onRemove={() => setConfirming(project)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <RemoveProjectDialog
        project={confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
        onConfirm={confirmRemoval}
      />
    </SettingsField>
  )
}

function ProjectRow({
  project,
  isBoot,
  workspaceMax,
  vocabulary,
  disabled,
  onRemove,
}: {
  project: ProjectListEntry
  isBoot: boolean
  workspaceMax: number
  vocabulary: readonly string[]
  disabled: boolean
  onRemove: () => void
}) {
  return (
    <tr data-slot="project-row" data-project={project.id} className="border-b border-border last:border-0">
      <th scope="row" className="max-w-0 px-3 py-2 text-left font-normal">
        <span className="block truncate text-foreground">{project.name}</span>
        <span className="block truncate font-mono text-[11px] text-soft-foreground" title={project.root}>
          {project.root}
        </span>
      </th>
      <td className="px-3 py-2">
        <span
          data-slot="project-status"
          className={project.status === 'missing' ? 'text-[12px] text-danger' : 'text-[12px] text-soft-foreground'}
        >
          {STATUS_LABEL[project.status]}
        </span>
        {project.status !== 'missing' ? (
          <span className="ml-1 text-[11px] text-soft-foreground">· {project.source}</span>
        ) : null}
      </td>
      <td className="px-3 py-2">
        <ProjectTagsEditor project={project} vocabulary={vocabulary} />
      </td>
      <td className="px-3 py-2">
        <MaxParallelSelect project={project} workspaceMax={workspaceMax} />
      </td>
      <td className="px-3 py-2 tabular-nums text-soft-foreground">{shortDate(project.addedAt)}</td>
      <td className="px-3 py-2 text-right">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-action="project-remove"
          // Names the gesture precisely for a screen reader, where the row context that makes a
          // bare "Remove" safe-sounding isn't read out with it — but LEADS with the button's own
          // word, so the accessible name contains the visible one (WCAG 2.5.3 Label in Name) and
          // speech input still reaches the control. Same shape as the General page's button.
          aria-label={`Remove ${project.name} from the workspace — unregisters it, no files are deleted`}
          // The boot project is refused server-side too (it re-registers itself at every start);
          // disabling here means the user gets the explanation before the click, not after.
          title={isBoot ? 'cezar is serving this project — it re-registers itself at every start' : undefined}
          disabled={disabled || isBoot}
          onClick={onRemove}
        >
          Remove
        </Button>
      </td>
    </tr>
  )
}

/**
 * Per-project tags — the labels that group CONNECTED repositories.
 *
 * The point is cross-repo work: tag the API, the web app and the design system `storefront` and
 * the global Tasks page (`/tasks`) can show all three as one list, or split every project's tasks
 * by tag. Nothing else in cezar reads them, deliberately — a tag is a lens, not a permission, a
 * queue or a routing rule.
 *
 * Bound to the server value with no local mirror of the list: the chips render `project.tags`
 * and every gesture sends the WHOLE new list through `PATCH /api/projects/:id`, whose answer the
 * hook invalidates the registry with. A failed save therefore reverts by simply not changing
 * anything, and two settings tabs cannot drift into two different tag sets. The only local state
 * is the text being typed, which is not a fact about the project until it is committed.
 *
 * Committing on Enter AND on comma, because both are what people type; blur does NOT commit, on
 * purpose — tabbing out of a half-typed word should not persist it.
 *
 * The field AUTOCOMPLETES from the tags already used anywhere in the registry, and that is not a
 * convenience — it is what makes the feature work. Tags only group anything if two projects spell
 * one the same way, and free text does not converge on its own: `storefront`, `store-front` and
 * `Storefront` are three groups that were meant to be one. The server can only deduplicate within
 * a single project's list; offering the existing vocabulary is what keeps the second repo landing
 * on the same word as the first. Focusing the empty field shows the whole vocabulary, because
 * "which tags exist here?" is the first question someone tagging a second repo has.
 */
export function ProjectTagsEditor({
  project,
  vocabulary,
}: {
  project: ProjectListEntry
  /** Every tag already in use ANYWHERE in the registry — the autocomplete list. Passed in
   *  rather than derived here so all rows share one computation of the workspace's vocabulary. */
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
    save([...tags, tag], `${project.name} tagged \u201c${tag}\u201d`)
  }

  const remove = (tag: string) => {
    save(
      tags.filter((existing) => existing !== tag),
      `\u201c${tag}\u201d removed from ${project.name}`,
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
          className="inline-flex max-w-full items-center gap-1 rounded-full bg-violet/15 py-px pr-1 pl-2 text-[11px] font-medium whitespace-nowrap text-violet"
        >
          {tag}
          <button
            type="button"
            data-action="project-tag-remove"
            // Names the project as well as the tag: in a table of rows that all offer a bare
            // "\u00d7", the row context a sighted reader has is not read out with the control.
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
            placeholder={tags.length === 0 ? 'Add tag\u2026' : '+'}
            value={draft}
            maxLength={PROJECT_TAG_MAX_LENGTH}
            disabled={update.isPending}
            onFocus={() => setOpen(true)}
            // Safe BECAUSE the suggestion buttons commit on `mousedown` with the default
            // prevented: picking one never moves focus, so a real blur always means "left the
            // field". This is the only thing that closes the list on an outside click now — see
            // the `onInteractOutside` note below.
            onBlur={() => setOpen(false)}
            onChange={(event) => {
              setOpen(true)
              setHighlight(-1)
              // A comma is a separator everywhere else tags are typed; treating it as one here
              // means pasting `api, web` does the obvious thing instead of one absurd tag.
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
                // Wraps through -1, which is "the text I typed" — so arrowing past the end of
                // the list returns to the draft rather than trapping you in the suggestions.
                const next = highlight + step
                setHighlight(next >= suggestions.length ? -1 : next < -1 ? suggestions.length - 1 : next)
                return
              }
              if (event.key === 'Escape' && listOpen) {
                // Closes the list only. The draft survives, because dismissing a suggestion
                // list is not the same gesture as abandoning what you typed.
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
              // Backspace on an empty field deletes the last chip \u2014 the standard token-field
              // gesture, and the only way to remove a tag from the keyboard without tabbing back
              // through every \u00d7.
              if (event.key === 'Backspace' && draft === '' && tags.length > 0) {
                event.preventDefault()
                const last = tags[tags.length - 1]
                if (last !== undefined) remove(last)
              }
            }}
            className="h-6 w-16 min-w-0 flex-1 rounded-md border border-input bg-card px-1.5 text-[12px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
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
          // THE fix for "the list blinks and vanishes on click".
          //
          // The list opens on the input's `focus`, and Radix's DismissableLayer adds its
          // document-level `focusin`/`pointerdown` listeners when the layer mounts — which is
          // during that very same focus dispatch, before it has finished bubbling to the
          // document. The layer therefore saw the focus that OPENED it as an interaction
          // outside itself and dismissed on the spot.
          //
          // Radix cannot distinguish those cases for us here, because the thing being focused
          // (the input) is deliberately outside the layer: this is an anchored listbox, not a
          // popover you move into. So the layer stops owning dismissal entirely and this
          // component owns it — `onBlur` for clicking away, Escape and Tab for the keyboard,
          // and picking a suggestion for the happy path.
          onInteractOutside={(event) => event.preventDefault()}
        >
          <p className="px-2 pt-1 pb-1.5 text-[10.5px] text-soft-foreground">
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
              // `onMouseDown` + preventDefault so the press never blurs the input first, and the
              // field keeps focus for the next tag you want to add.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                add(tag)
                inputRef.current?.focus()
              }}
              onMouseEnter={() => setHighlight(index)}
              className={cn(
                'flex w-full items-center rounded-sm px-2 py-1 text-left text-[12px] font-medium text-violet',
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
 * Per-project "Max parallel tasks" selector (spec 2026-07-22). `Inherit
 * workspace (N)` is the unset default; `1..16` pins a per-project ceiling.
 * Bound directly to the server value (`project.maxParallel`) and saved on
 * change, mirroring the workspace `Max parallel` control (resources-section.tsx)
 * — a failed save reverts because the value never leaves the server's, and the
 * hook invalidates the projects query so a success re-renders the row. The
 * workspace cap still clamps at runtime, which the section hint explains.
 */
export function MaxParallelSelect({
  project,
  workspaceMax,
}: {
  project: ProjectListEntry
  workspaceMax: number
}) {
  const update = useUpdateProject()
  // `''` is the inherit sentinel; a number is an explicit per-project ceiling.
  const value = project.maxParallel === undefined ? '' : String(project.maxParallel)
  return (
    <select
      aria-label={`Max parallel tasks for ${project.name}`}
      data-slot="project-max-parallel"
      value={value}
      disabled={update.isPending}
      onChange={(event) => {
        const raw = event.target.value
        const next = raw === '' ? null : Number(raw)
        update.mutate(
          { id: project.id, maxParallel: next },
          {
            onSuccess: () =>
              toast(
                next === null
                  ? `${project.name} inherits the workspace limit (${workspaceMax})`
                  : `${project.name} runs at most ${next} task${next === 1 ? '' : 's'} at a time`,
              ),
            onError: (error: Error) => toast(error.message, { tone: 'danger' }),
          },
        )
      }}
      className="block w-44 rounded-md border border-input bg-card px-2 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
    >
      <option value="">Inherit workspace ({workspaceMax})</option>
      {Array.from(
        { length: MAX_PARALLEL_MAX - MAX_PARALLEL_MIN + 1 },
        (_, i) => i + MAX_PARALLEL_MIN,
      ).map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  )
}
