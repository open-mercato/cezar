import { BookmarkIcon, CopyIcon, GripVerticalIcon, SearchIcon, ZapIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useHealth, useLaunchKey, useProjects, useSkills } from '@/api/queries'
import type { Skill } from '@open-mercato/cezar-api-client'
import { repoChipOf } from '@/components/app-shell-container'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { bookmarkletUrl } from '@/lib/bookmarklet'
import { useActiveProjectId } from '@/lib/project-router'
import { orderSkills } from '@/lib/skills'
import {
  SettingsError,
  SettingsField,
  SettingsGroup,
  SettingsLoading,
  SettingsPane,
} from './settings-field'

/** Settings → Bookmarklets (spec 011): the legacy generic and per-skill launchers promoted
 *  to a first-class, discoverable Settings subpage. */
export function BookmarkletsSection() {
  const skillsQuery = useSkills()

  // Without this the in-flight catalog renders as the panel's empty state, which tells the
  // user "(no skills yet)" — a claim that is simply false while the fetch is still running.
  if (skillsQuery.isPending) {
    return <SettingsLoading data-slot="bookmarklets-loading" label="Loading bookmarklets…" />
  }
  if (skillsQuery.isError) {
    return <SettingsError title="Could not load bookmarklets">{skillsQuery.error.message}</SettingsError>
  }

  return <BookmarkletPanel skills={orderSkills(skillsQuery.data ?? [])} />
}

/**
 * The bookmarklet generator panel (spec 011, ported from the legacy cockpit): draggable
 * `javascript:` links against the protected `/new?skill=&key=` contract (`lib/bookmarklet`).
 * A failed key fetch degrades exactly like legacy — the links still generate, auto-start
 * just will not arm.
 *
 * Project-scoped since the multi-project spec (step 3.6): the pane lives under each project's
 * settings, and the links it makes carry that project's URL prefix AND that project's launch
 * key. Both fall out of the surrounding scope machinery — nothing here picks a project.
 *
 * Exported so the former Settings → Skills deep link remains compatible while the same
 * generator also has its own Settings subpage.
 */
export function BookmarkletPanel({ skills }: { skills: readonly Skill[] }) {
  const launchKey = useLaunchKey()
  const health = useHealth()
  const projects = useProjects()
  const [auto, setAuto] = useState(false)
  const [filter, setFilter] = useState('')
  // THIS project's own launch key: `useLaunchKey` goes through the scoped API client, so under
  // `/p/<id>/settings` it reads `/api/p/<id>/launch-key` — that repo's `.ai/cezar/launch-key`,
  // which is the only secret the target cockpit scope will accept (multi-project spec, 3.6).
  const key = launchKey.data?.key ?? ''
  // Bake THIS cockpit's origin into the bookmarklets so a click opens the very instance that
  // generated them — no localhost port-scan (GitHub's CSP blocks that fetch). See bookmarklet.ts.
  const origin = window.location.origin
  // …and the project the URL should land in. The boot project mounts UNSCOPED, so the context
  // says null and the URL's own `/p/<id>` prefix is what answers (see `useActiveProjectId`);
  // `bootProject` covers the sliver of time a legacy flat URL is still mid-redirect. Null all
  // the way down degrades to the legacy flat `/new`, which redirects to the boot project — so
  // the generator never emits a URL that fails to land.
  const projectId = useActiveProjectId() ?? health.data?.bootProject ?? null
  // The project name stamped into the bookmark's visible label, so a person with several
  // projects (or several cockpits) open can tell their bookmarks apart in the bar (#422). The
  // REGISTRY answers per project: `/api/health` is workspace-level (never scoped) and always
  // describes the boot repo, so reading the name from it would stamp the boot project's name
  // onto every other project's launchers. It stays the fallback for the registry-unavailable
  // case. Null (outside a git repo, nothing known): the label drops the stamp rather than
  // guessing a name.
  const repoName =
    projects.data?.projects.find((project) => project.id === projectId)?.name ??
    repoChipOf(health.data)?.name ??
    null
  const needle = filter.trim().toLowerCase()
  const shown = skills.filter((skill) => skill.name.toLowerCase().includes(needle))

  return (
    <SettingsPane data-slot="bookmarklet-panel">
      <SettingsGroup
        title="Run from GitHub"
        description={
          <>
            Drag a button below to your browser&apos;s bookmarks bar. On any GitHub PR or issue, click it
            to open this cockpit directly. The cockpit must be running:{' '}
            <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">npx cezar</code>.
          </>
        }
      >
        <SettingsField
          title="One-click launch (auto-submit)"
          htmlFor="bm-auto"
          hint="Start the task as soon as the bookmark is clicked. Re-drag the buttons after changing this."
          control={<Switch id="bm-auto" data-slot="bm-auto" checked={auto} onCheckedChange={setAuto} />}
        />
        <div data-slot="bm-generic">
          {/* Generic launcher: no skill, auto forced off — it only prefills the form. */}
          <BookmarkletRow
            label={repoName ? `cezar (${repoName}): this PR/issue` : 'cezar: this PR/issue'}
            url={bookmarkletUrl('', false, key, origin, projectId)}
            hint="prefills the form — nothing starts by itself"
          />
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Skill launchers"
        description="One bookmark per skill — it opens the composer with that skill picked."
        bare
      >
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            data-slot="bm-filter"
            placeholder="Filter skills…"
            aria-label="Filter bookmarklet skills"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </InputGroup>
        {shown.length > 0 ? (
          <Card flush data-slot="bm-list" className="divide-y divide-border">
            {shown.map((skill) => (
              <BookmarkletRow
                key={skill.path}
                label={repoName ? `/${skill.name} (${repoName})` : `/${skill.name}`}
                url={bookmarkletUrl(skill.name, auto, key, origin, projectId)}
                hint={skill.source}
              />
            ))}
          </Card>
        ) : (
          <Empty data-slot="bm-list" className="rounded-xl border border-dashed border-border py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BookmarkIcon />
              </EmptyMedia>
              <EmptyTitle>{skills.length > 0 ? 'No skills match' : 'No skills yet'}</EmptyTitle>
              <EmptyDescription>
                {skills.length > 0 ? 'Try a different filter.' : 'The generic launcher above still works.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </SettingsGroup>
    </SettingsPane>
  )
}

function BookmarkletRow({ label, url, hint }: { label: string; url: string; hint?: string }) {
  // React (rightly) refuses `javascript:` hrefs at render time — but a bookmarklet IS one by
  // definition, and dragging to the bookmarks bar needs the real href on the DOM node. The
  // link is a drag source only (the click handler below never lets it execute), so setting
  // the attribute imperatively is the honest escape hatch.
  const anchor = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    anchor.current?.setAttribute('href', url)
  }, [url])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      toast('Bookmarklet URL copied.')
    } catch {
      toast('Copy failed — drag the button instead.', { tone: 'danger' })
    }
  }
  return (
    <div data-slot="bm-row" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-3">
      {/* A drag SOURCE only — the cockpit page never executes the javascript: URL itself
          (spec 011 §5), so a plain click just explains the gesture. */}
      <a
        ref={anchor}
        draggable
        data-slot="bm-link"
        title="Drag me to your bookmarks bar"
        onClick={(event) => {
          event.preventDefault()
          toast('Drag me to your bookmarks bar')
        }}
        className="inline-flex h-8 max-w-full min-w-0 cursor-grab items-center gap-1.5 rounded-md border border-input bg-card pr-3 pl-2 font-mono text-xs font-medium text-foreground shadow-2xs transition-colors hover:bg-muted active:cursor-grabbing"
      >
        <GripVerticalIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />
        <ZapIcon aria-hidden="true" className="size-3 shrink-0 text-primary-strong" />
        <span className="truncate">{label}</span>
      </a>
      {hint ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{hint}</span> : <span className="flex-1" />}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-slot="bm-copy"
        title="Copy the bookmarklet URL"
        onClick={() => void copy()}
      >
        <CopyIcon aria-hidden="true" className="size-3.5" />
        Copy
      </Button>
    </div>
  )
}
