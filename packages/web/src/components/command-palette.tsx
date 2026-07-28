import { MoonIcon, PlusIcon } from 'lucide-react'
import * as React from 'react'
import { useHealth, useRuns, useSkills, useUiState } from '@/api/queries'
import { useNavigate } from '@/lib/project-router'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { visibleNavItems } from '@/components/nav-items'
import { StatusDot } from '@/components/status-dot'
import { NEXT_THEME } from '@/components/theme-toggle'
import { useTheme } from '@/components/theme-provider'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { deriveAttention } from '@/lib/attention'
import { shortAge } from '@/lib/format'
import { orderSkillsByUsage } from '@/lib/skills'
import { runTitle } from '@/lib/task-groups'
import { useCommandShortcut, useKeyShortcut } from '@/lib/use-command-shortcut'

/**
 * The ⌘K command palette (spec, "Cross-cutting"): tasks, views, actions, skills — everything,
 * one keystroke from anywhere.
 *
 * Opened by ⌘K *and* Ctrl+K (the shared `useCommandShortcut` registers both together), by the
 * sidebar footer's hint, or programmatically via `openCommandPalette()`. Escape and selecting
 * anything close it.
 */

/** The programmatic-open seam: a window event rather than a context, so chrome that must stay
 *  presentational (the sidebar hint today, an onboarding nudge tomorrow) can open the palette
 *  without threading a setter through the tree. */
export const OPEN_COMMAND_PALETTE_EVENT = 'cezar:open-command-palette'

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))
}

/** Newest first — the palette's unfiltered Tasks group should lead with what you touched last,
 *  exactly like the sidebar. Stable for equal timestamps (variant groups started together). */
export function orderRuns(runs: readonly RunRecord[]): RunRecord[] {
  return [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

export function CommandPalette() {
  const [open, setOpen] = React.useState(false)
  const navigate = useNavigate()

  useCommandShortcut('k', () => setOpen((current) => !current))
  const newTask = React.useCallback(() => {
    setOpen(false)
    navigate('/new')
  }, [navigate])
  // ⌘N works only in the desktop shell — the browser reserves it (new window), so the page
  // never sees it. `c`-to-create (GitHub/Linear) is the browser-usable accelerator and the one
  // the hint chips advertise; ⌘N stays registered for the Electron shell where it fires.
  useCommandShortcut('n', newTask)
  useKeyShortcut('c', newTask)

  React.useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
  }, [])

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search tasks, views, actions, and skills"
      showCloseButton={false}
    >
      {/* The body mounts only while the dialog is open (Radix portals nothing when closed), so
          its queries — notably the skills fetch — run on first open, never on app boot. */}
      <PaletteContent close={() => setOpen(false)} />
    </CommandDialog>
  )
}

function PaletteContent({ close }: { close: () => void }) {
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()
  // Runs are already cached by the sidebar's quick-list; skills fetch here, on first open.
  const runs = useRuns()
  const skills = useSkills()
  // Skills list most-used → project → global (#519) — the same order every picker renders.
  const uiState = useUiState()
  // Health is cached by the shell's chips; here it gates the forge-gated Views row (R6 1.1) —
  // the palette must not offer a GitHub view the sidebar honestly hides.
  const health = useHealth()
  const now = Date.now()

  const orderedRuns = React.useMemo(() => orderRuns(runs.data ?? []), [runs.data])
  const skillUsage = uiState.data?.skillUsage
  const orderedSkills = React.useMemo(
    () => orderSkillsByUsage(skills.data ?? [], skillUsage),
    [skills.data, skillUsage],
  )

  const go = (to: string) => {
    close()
    navigate(to)
  }
  const nextTheme = NEXT_THEME[theme]

  return (
    <>
      <CommandInput placeholder="Search tasks, views, actions, skills…" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>

        <CommandGroup heading="Views">
          {visibleNavItems({
            forge: health.data?.forge?.available === true,
            inbox: health.data?.capabilities.followups === true,
          }).map((item) => {
            const Icon = item.icon
            return (
              <CommandItem
                key={item.to}
                // The `view` prefix keeps values unique across groups and gives "view git" a
                // deterministic hit; the value is filter fodder, never rendered.
                value={`view ${item.label}`}
                data-slot="palette-view"
                data-nav-to={item.to}
                onSelect={() => go(item.to)}
              >
                <Icon aria-hidden="true" />
                {item.label}
              </CommandItem>
            )
          })}
          <CommandItem
            value="view new task"
            data-slot="palette-view"
            data-nav-to="/new"
            onSelect={() => go('/new')}
          >
            <PlusIcon aria-hidden="true" />
            New task
            <CommandShortcut>C</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        {orderedRuns.length > 0 ? (
          <CommandGroup heading="Tasks">
            {orderedRuns.map((run) => {
              const attention = deriveAttention(run)
              return (
                <CommandItem
                  key={run.id}
                  // The id keeps duplicate titles apart; it also lets a pasted run id find its task.
                  // `runTitle`, matching the rendered text — filtering on a raw title hidden
                  // behind an auto-summary would surface rows for no visible reason.
                  value={`task ${runTitle(run)} ${run.id}`}
                  data-slot="palette-task"
                  data-run-id={run.id}
                  onSelect={() => go(`/tasks/${run.id}`)}
                >
                  <StatusDot tone={attention.tone} pulse={attention.pulse} aria-label={attention.label} role="img" />
                  <span className="min-w-0 flex-1 truncate">{runTitle(run)}</span>
                  <span className="shrink-0 text-xs text-soft-foreground tabular-nums">
                    {shortAge(run.finishedAt ?? run.createdAt, now)}
                  </span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        ) : null}

        <CommandGroup heading="Actions">
          <CommandItem
            value="action toggle theme"
            data-slot="palette-action"
            data-action="toggle-theme"
            onSelect={() => {
              setTheme(nextTheme)
              close()
            }}
          >
            <MoonIcon aria-hidden="true" />
            Toggle theme
            <CommandShortcut className="tracking-normal">
              {theme} → {nextTheme}
            </CommandShortcut>
          </CommandItem>
          <CommandItem
            value="action new task"
            data-slot="palette-action"
            data-action="new-task"
            onSelect={() => go('/new')}
          >
            <PlusIcon aria-hidden="true" />
            New task
          </CommandItem>
        </CommandGroup>

        {orderedSkills.length > 0 ? (
          <CommandGroup heading="Skills">
            {orderedSkills.map((skill) => (
              <CommandItem
                key={skill.path}
                // The path suffix keeps values unique when a project skill shadows a global
                // one of the same name — both stay selectable.
                value={`skill ${skill.name} ${skill.path}`}
                keywords={skill.description ? [skill.description] : undefined}
                data-slot="palette-skill"
                data-skill={skill.name}
                onSelect={() => go(`/new?skill=${encodeURIComponent(skill.name)}`)}
              >
                <span className="shrink-0 font-medium">{skill.name}</span>
                {skill.description ? (
                  <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">{skill.description}</span>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </>
  )
}
