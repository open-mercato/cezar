import { CircleHelpIcon, PlusIcon } from 'lucide-react'
import * as React from 'react'
import type { AutomationsResponse } from '@open-mercato/cezar-api-client'

import { GithubIcon } from '@/components/icons'
import { ChoiceTile, GuideDialog, OnboardingPage, PreviewWindow, previewLine, quietLink, type GuidePage } from '@/components/onboarding-kit'
import { Button } from '@/components/ui/button'
import { Link, useNavigate } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/**
 * The automations explainer (spec 2026-10-26-first-run-onboarding § Automations). With no
 * automation yet the page says what one is — a prompt cezar turns into a task on its own — shows
 * the three things that can start it, and how it goes live: written as a prompt, paused first,
 * every run an ordinary task. Each tile opens the editor on that trigger. The same story, in
 * pictures, sits behind "How it works" in the header for anyone who comes back to it later.
 */

export type TriggerKind = 'schedule' | 'github' | 'tracker'

export function AutomationsOnboarding({ data }: { data: AutomationsResponse }) {
  const navigate = useNavigate()
  const [guide, setGuide] = React.useState(false)
  const githubMissing = data.available === false
  const open = (kind: TriggerKind) => navigate(`/automations/new?kind=${kind}`)
  return (
    <OnboardingPage
      wide
      slot="automations"
      title="Let the routine run itself"
      why="An automation is a prompt cezar turns into a task on its own: at a time you set, when something happens on GitHub, or when an issue moves in Jira or Linear."
    >
      <div data-slot="automation-triggers" className="mt-8 grid w-full gap-3 sm:grid-cols-3">
        <ChoiceTile
          title="On a schedule"
          description="Every weekday at 9:00, Fridays at 16:00, every six hours."
          recommended
          onClick={() => open('schedule')}
          picture={<SchedulePicture />}
        />
        <ChoiceTile
          title="When GitHub changes"
          description={githubMissing ? 'Sign in to the GitHub CLI first.' : 'A new pull request, an issue labelled, a review requested.'}
          onClick={() => (githubMissing ? navigate('/github') : open('github'))}
          picture={githubMissing ? <GithubIcon className="size-9 text-muted-foreground" aria-hidden={true} /> : <GithubPicture />}
        />
        <ChoiceTile
          title="When an issue moves"
          description="A Jira or Linear issue is created or changes status."
          onClick={() => open('tracker')}
          picture={<TrackerPicture />}
        />
      </div>

      <ol data-slot="automation-steps" className="mt-10 grid w-full gap-6 text-left sm:grid-cols-3">
        {HOW_IT_WORKS.map((step, at) => (
          <li key={step.title} className="flex gap-3">
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-violet font-mono text-meta text-foreground" aria-hidden="true">
              {at + 1}
            </span>
            <span className="flex flex-col gap-1">
              <span className="text-lead text-foreground">{step.title}</span>
              <span className="text-label text-muted-foreground">{step.body}</span>
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-10 flex flex-col items-center gap-4">
        <Button asChild className="font-normal">
          <Link to="/automations/new">
            <PlusIcon className="size-[15px]" aria-hidden="true" />
            New automation
          </Link>
        </Button>
        <button type="button" className={quietLink} onClick={() => setGuide(true)}>
          <CircleHelpIcon className="size-3.5" aria-hidden="true" />
          See it in pictures
        </button>
      </div>
      {guide ? <AutomationsGuide onOpenChange={setGuide} /> : null}
    </OnboardingPage>
  )
}

const HOW_IT_WORKS = [
  {
    title: 'Write it as a prompt',
    body: 'Say what the agent should do each time. Placeholders such as {{github.url}} or {{date}} fill in per run.',
  },
  {
    title: 'Preview, then enable',
    body: 'A new automation starts paused. A poll shows what it would have matched, a schedule shows its next runs. Enable it when that looks right.',
  },
  {
    title: 'Every run is a task',
    body: 'Each match starts an ordinary task in its own worktree. It ends at the review gate, never merges on its own, and the log keeps every run.',
  },
] as const

/** The header's way into the same story, for whoever already has automations and wants the picture. */
export function AutomationsGuideButton() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button variant="ghost" size="sm" data-slot="automations-guide" aria-label="How automations work" className="text-muted-foreground" onClick={() => setOpen(true)}>
        <CircleHelpIcon aria-hidden="true" className="size-3.5" />
        <span className="max-md:hidden">How it works</span>
      </Button>
      {open ? <AutomationsGuide onOpenChange={setOpen} /> : null}
    </>
  )
}

function AutomationsGuide({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const pages: GuidePage[] = [
    {
      id: 'prompt',
      title: 'A prompt that runs itself',
      body: 'An automation is the same thing you type into New task, kept and run for you. Placeholders fill in what changed: the pull request, the issue, the date.',
      picture: <PromptPicture />,
    },
    {
      id: 'triggers',
      title: 'Three ways to start',
      body: 'On a schedule, when GitHub changes, or when an issue moves in Jira or Linear. A GitHub or tracker automation polls every few minutes and starts one task per match.',
      picture: <TriggersPicture />,
    },
    {
      id: 'paused',
      title: 'Paused first, then live',
      body: 'A new automation is paused. Preview shows what it would have matched, or when it runs next. Enable it when that looks right, and pause it again any time.',
      picture: <PausedPicture />,
    },
    {
      id: 'tasks',
      title: 'Every run is a task',
      body: 'Each run shows up in the task list like one you started yourself, in its own worktree, ending at the review gate. The automation’s log keeps every run.',
      picture: <RunsPicture />,
      action: { label: 'New automation', onClick: () => navigate('/automations/new') },
    },
  ]
  return <GuideDialog slot="automations-guide-page" title="How automations work" description="Four things to know." pages={pages} onOpenChange={onOpenChange} />
}

// ---- pictures -----------------------------------------------------------------------------------

const row = 'flex items-center gap-2 rounded-md px-2 py-1 text-micro'

function Toggle({ on = true }: { on?: boolean }) {
  return (
    <span className={cn('flex h-3.5 w-6 items-center rounded-full px-0.5', on ? 'justify-end bg-violet' : 'justify-start bg-muted-foreground/40')}>
      <span className="size-2.5 rounded-full bg-background" />
    </span>
  )
}

function SchedulePicture() {
  return (
    <span className="flex w-20 flex-col gap-1">
      {['Mon 09:00', 'Fri 16:00'].map((when, at) => (
        <span key={when} className={cn('flex items-center justify-between rounded-md border px-1.5 py-1 font-mono text-[9px]', at === 0 ? 'border-violet bg-violet/15 text-foreground' : 'border-border text-muted-foreground')}>
          {when}
          <span className={cn('size-1.5 rounded-full', at === 0 ? 'bg-violet' : 'bg-muted-foreground/50')} />
        </span>
      ))}
    </span>
  )
}

function GithubPicture() {
  return (
    <span className="flex w-20 flex-col gap-1.5">
      <span className="flex items-center gap-1.5 rounded-md border border-violet bg-violet/15 px-1.5 py-1">
        <span className="size-1.5 rounded-full bg-violet" />
        <span className="h-1 flex-1 rounded bg-violet/60" />
        <span className="rounded-sm bg-violet/40 px-1 text-[7px] text-foreground">PR</span>
      </span>
      <span className="flex items-center gap-1.5 rounded-md border border-border px-1.5 py-1">
        <span className="size-1.5 rounded-full bg-muted-foreground/50" />
        <span className="h-1 w-2/3 rounded bg-muted" />
      </span>
    </span>
  )
}

function TrackerPicture() {
  return (
    <span className="flex items-center gap-1.5 font-mono text-[9px]">
      <span className="rounded-md border border-border px-1.5 py-1 text-muted-foreground">To do</span>
      <span className="h-px w-3 bg-violet" />
      <span className="rounded-md border border-violet bg-violet/15 px-1.5 py-1 text-foreground">Ready</span>
    </span>
  )
}

function PromptPicture() {
  return (
    <PreviewWindow bar={<span className="ml-3 text-micro text-soft-foreground">What to run</span>}>
      <p className="text-meta leading-relaxed text-foreground">
        Review <span className="rounded-sm bg-violet/15 px-1 text-violet">{'{{github.url}}'}</span> for real issues only and leave one comment per finding.
      </p>
      <div className={cn(previewLine, 'mt-3 w-1/2')} />
    </PreviewWindow>
  )
}

function TriggersPicture() {
  return (
    <PreviewWindow>
      {['Every weekday at 9:00', 'When a pull request opens', 'When PROJ-42 reaches Ready'].map((trigger, at) => (
        <div key={trigger} style={{ '--i': at } as React.CSSProperties} className={cn(row, 'tip-rise justify-between text-foreground')}>
          <span>{trigger}</span>
          <Toggle />
        </div>
      ))}
    </PreviewWindow>
  )
}

function PausedPicture() {
  return (
    <PreviewWindow>
      <div className={cn(row, 'justify-between text-foreground')}>
        <span>Triage new issues</span>
        <span className="flex items-center gap-2 text-[9.5px] text-soft-foreground">
          paused
          <Toggle on={false} />
        </span>
      </div>
      <div style={{ '--i': 2 } as React.CSSProperties} className="tip-rise mt-2 rounded-md border border-violet/50 bg-violet/10 px-2 py-1.5 text-micro text-foreground">
        Preview: would have matched 3 issues this week
      </div>
      <div style={{ '--i': 5 } as React.CSSProperties} className={cn(row, 'tip-rise mt-2 justify-between text-foreground')}>
        <span>Triage new issues</span>
        <span className="flex items-center gap-2 text-[9.5px] text-violet">
          enabled
          <Toggle />
        </span>
      </div>
    </PreviewWindow>
  )
}

function RunsPicture() {
  return (
    <PreviewWindow bar={<span className="ml-3 text-micro text-soft-foreground">Tasks</span>}>
      {[
        ['needs review', 'Triage issue 412: missing repro', 'text-violet'],
        ['running', 'Nightly dependency bump', 'text-success'],
        ['done', 'Weekly changelog draft', 'text-muted-foreground'],
      ].map(([status, title, tone], at) => (
        <div key={title} style={{ '--i': at } as React.CSSProperties} className={cn(row, 'tip-rise text-foreground')}>
          <span className={cn('w-16 shrink-0 text-[9.5px]', tone)}>{status}</span>
          <span className="truncate">{title}</span>
        </div>
      ))}
    </PreviewWindow>
  )
}
