import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowRightIcon,
  CheckIcon,
  CopyIcon,
  FileTextIcon,
  FlaskConicalIcon,
    FolderIcon,
  GiftIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  GitCommitHorizontalIcon,
  PackageIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react'
import * as React from 'react'
import { useNavigate as useGlobalNavigate } from 'react-router'

import { ApiError, putWorkspaceUiState } from '@/api/client'
import {
  useConfig,
  useConnectAgentAccount,
  useGithubLogin,
  useGithubOwners,
  useHealth,
  useInitProjectGit,
  useProjects,
  useProviderStatus,
  usePublishProjectGithub,
  useRefreshProviderStatus,
  useRegisterProject,
  useRepo,
  useRepoSuggestions,
  useRuns,
  useSkills,
  useGithub,
  useWorkspaceUiState,
  workspaceQueryKeys,
} from '@/api/queries'
import { useProjectScope } from '@/api/project-scope-context'
import type { GithubItem, ProviderId, RepoSuggestion, RunRecord, WorkspaceUiState } from '@open-mercato/cezar-api-client'
import { AddProjectDialog } from '@/components/add-project-dialog'
import { CloneProjectDialog } from '@/components/clone-project-dialog'
import { CreateProjectDialog } from '@/components/create-project-dialog'
import { DialogErrorBoundary } from '@/components/dialog-error-boundary'
import { GithubIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from '@/components/ui/toaster'
import { NAV_ITEMS } from '@/components/nav-items'
import {
  agentSetupRows,
  announcementsSince,
  currentAnnouncement,
  hasSignedInAgent,
  navOwnsPath,
  newFeaturePaths,
  pendingSetupSteps,
  recentAnnouncements,
  tasksNeedingYou,
  visitPatch,
  welcomeBackSince,
  whatsNewHasUnseen,
  welcomeBackSentence,
  type Announcement,
  type FeaturePreviewId,
  type SetupStep,
} from '@/lib/onboarding'
import { Link, useNavigate } from '@/lib/project-router'
import { newTaskPrefillHref } from '@/routes/new-task-params'
import { shortAge } from '@/lib/format'
import { githubTaskRef } from '@/lib/github-task'
import { labelChipStyle } from '@/routes/github/github-filter'
import { trackAddProjectOpened } from '@/lib/telemetry'
import { cn } from '@/lib/utils'

/**
 * First-run onboarding (spec 2026-10-26-first-run-onboarding, mockups in
 * `.ai/specs/assets/2026-10-26-first-run-onboarding/`). Replaces the "No tasks yet" empty state with one
 * page per situation: no agent → sign in; no git → pick a project; otherwise → describe a task.
 * Layout follows a "new project" page: a large light title, one wide input, then sections split
 * by hairlines. Hierarchy comes from size, never from weight.
 */
/** `gitRepo` is `undefined` while the project's git state is unknown. */
export function FirstRun({ gitRepo }: { gitRepo: boolean | undefined }) {
  const providers = useProviderStatus()
  const uiState = useWorkspaceUiState()
  // Provider detection can miss a login that works, so the sign-in page is skippable for good.
  const skipped = uiState.data?.onboarding?.agentCheckSkipped === true
  // Nothing until the agent answer is in: a welcome that flips to "sign in" a moment later is worse
  // than a short blank.
  if (providers.data === undefined && !skipped) return null
  if (hasSignedInAgent(providers.data) === false && !skipped) return <SignInToAgent />
  // The same for git: a welcome that flips to "pick a project" once `/repo` answers is a flash of
  // the wrong page.
  if (gitRepo === undefined) return null
  if (!gitRepo) return <PickProject />
  return <Welcome />
}

/** Merge a patch into the workspace `onboarding` prefs: optimistic, reverted with a toast on error. */
function useOnboardingWrite() {
  const queryClient = useQueryClient()
  return React.useCallback(
    (patch: NonNullable<WorkspaceUiState['onboarding']>) => {
      const key = workspaceQueryKeys.uiState
      const previous = queryClient.getQueryData<WorkspaceUiState>(key)
      const onboarding = { ...previous?.onboarding, ...patch }
      queryClient.setQueryData<WorkspaceUiState>(key, { ...previous, onboarding })
      putWorkspaceUiState({ onboarding })
        .then((merged) => queryClient.setQueryData(key, merged))
        .catch((error: unknown) => {
          queryClient.setQueryData(key, previous)
          toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        })
    },
    [queryClient],
  )
}

function Page({
  title,
  slot,
  step,
  why,
  subtitle,
  banner,
  children,
}: {
  title: string
  slot: string
  /** The rail and the why-line belong to the two obstacle pages; the welcome page is the goal. */
  step?: StepId
  /** One line under the title: why this step matters, in plain words. */
  why?: string
  subtitle?: React.ReactNode
  banner?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section
      data-onboarding=""
      data-slot="first-run"
      data-first-run={slot}
      className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center px-1 pt-6 pb-12 text-center md:pt-12"
    >
      {banner}
      {step ? <StepRail current={step} /> : null}
      <h2 className={cn('text-4xl font-light tracking-tight text-balance text-foreground', step && 'mt-8')}>{title}</h2>
      {why ? <p className="mt-3 max-w-md text-[15px] text-muted-foreground">{why}</p> : null}
      {subtitle ? <p className="mt-2 text-[14px] text-muted-foreground">{subtitle}</p> : null}
      {children}
    </section>
  )
}

type StepId = 'agent' | 'project' | 'task'
const STEPS: ReadonlyArray<{ id: StepId; label: string }> = [
  { id: 'agent', label: 'Agent' },
  { id: 'project', label: 'Project' },
  { id: 'task', label: 'First task' },
]

/** The thread through the first run: three steps, the ones behind the current one ticked. Derived
 *  from the same state that picks the page, so it can never disagree with it. */
function StepRail({ current }: { current: StepId }) {
  const index = STEPS.findIndex((step) => step.id === current)
  return (
    <ol data-slot="step-rail" className="flex items-center gap-2 text-[12.5px]">
      {STEPS.map((step, i) => {
        const state = i < index ? 'done' : i === index ? 'current' : 'next'
        return (
          <li key={step.id} data-step={step.id} data-state={state} className="flex items-center gap-2">
            {i > 0 ? <span className={cn('h-px w-6', i <= index ? 'bg-violet/60' : 'bg-border')} aria-hidden="true" /> : null}
            <span
              className={cn(
                'inline-flex items-center gap-1.5',
                state === 'current' ? 'text-foreground' : state === 'done' ? 'text-muted-foreground' : 'text-soft-foreground',
              )}
            >
              <span
                className={cn(
                  'grid size-5 place-items-center rounded-full border font-mono text-[10px]',
                  state === 'done' && 'border-violet/60 bg-violet/15 text-violet',
                  state === 'current' && 'border-violet text-foreground',
                  state === 'next' && 'border-border text-soft-foreground',
                )}
                aria-hidden="true"
              >
                {state === 'done' ? <CheckIcon className="size-3" /> : i + 1}
              </span>
              {step.label}
              {state === 'current' ? <span className="sr-only">(current step)</span> : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

type IconComponent = React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>

const quiet = 'inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground'

const chip =
  'inline-flex h-[30px] items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground'

/**
 * Half the desktop sidebar's width: an onboarding dialog belongs to the page it opened from, so it
 * centres over the content column, not the whole window. Zero below `md`, where the sidebar is a
 * drawer and the content is the window.
 */
function useContentCenterOffset(): number {
  const [offset, setOffset] = React.useState(0)
  React.useLayoutEffect(() => {
    const measure = () => {
      const sidebar = document.querySelector<HTMLElement>('aside[data-slot="sidebar"]')
      setOffset(sidebar ? Math.max(0, sidebar.getBoundingClientRect().right) / 2 : 0)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  return offset
}

/** Every onboarding dialog: a header band (title, one line), a body, a footer band with the buttons. */
function OnboardingDialog({
  title,
  description,
  onOpenChange,
  onSubmit,
  footer,
  wide = false,
  children,
}: {
  title: string
  description: string
  /** Room for a picture: "What's new" draws each feature. */
  wide?: boolean
  onOpenChange: (open: boolean) => void
  /** Cmd/Ctrl+Enter. */
  onSubmit?: () => void
  footer: React.ReactNode
  children: React.ReactNode
}) {
  const contentOffset = useContentCenterOffset()
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        data-onboarding=""
        className={cn('gap-0 p-0', wide ? 'sm:max-w-lg' : 'sm:max-w-md')}
        style={contentOffset ? { left: `calc(50% + ${contentOffset}px)` } : undefined}
        onKeyDown={(event) => {
          if (onSubmit && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            onSubmit()
          }
        }}
      >
        <DialogHeader className="border-b border-border px-6 py-5 text-left">
          <DialogTitle className="text-xl font-light tracking-tight">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="px-6 py-5 text-left">{children}</div>
        <DialogFooter className="border-t border-border px-6 py-4">{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Numbered, plain-words steps for people who have never opened a terminal. */
function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="flex list-decimal flex-col gap-2.5 pl-5 text-[13px] text-muted-foreground marker:text-soft-foreground">{children}</ol>
}

const GH_INSTALL_URL = 'https://cli.github.com'

/**
 * Signing the GitHub CLI in, done by cezar (spec 2026-10-26-first-run-onboarding, "Sign in does
 * the work"): the dialog starts `gh auth login` the moment it needs a login, shows the one-time
 * code GitHub asks for, and the browser is already on the page that takes it (the server refuses
 * a hosted cockpit, whose host is not the user's machine). GitHub Desktop and the device flow it mirrors: one action, no terminal. `onDone`
 * fires once GitHub approves, so the dialog that owns the sign-in can close itself or carry on.
 */
function useGithubSignIn(enabled: boolean, onDone: (login: string | undefined) => void) {
  const login = useGithubLogin(onDone)
  const begin = login.start.mutate
  React.useEffect(() => {
    if (enabled) begin()
  }, [enabled, begin])
  return login
}

type GithubSignIn = ReturnType<typeof useGithubSignIn>

function githubSignInLine(signIn: GithubSignIn): string {
  const state = signIn.state
  if (signIn.start.error) return signInErrorMissing(signIn.start.error) ? 'The GitHub CLI is not installed.' : 'Sign-in did not finish.'
  if (state?.status === 'pending') return 'Enter this code on GitHub. It opened in your browser.'
  if (state?.status === 'failed') return 'Sign-in did not finish.'
  if (state?.status === 'done') return 'Signed in.'
  return 'Signing in through your browser.'
}

function signInErrorMissing(error: Error): boolean {
  return error instanceof ApiError && error.status === 503
}

/** Copying can fail (no clipboard permission, a remote cockpit over plain http): say what to do. */
function copyText(text: string, fallback: string) {
  const write = navigator.clipboard?.writeText(text)
  if (!write) {
    toast(fallback)
    return
  }
  void write.then(
    () => toast('Copied'),
    () => toast(fallback),
  )
}

function SignInProgress({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
      {children}
    </p>
  )
}

function GithubSignInBody({ signIn }: { signIn: GithubSignIn }) {
  const state = signIn.state
  if (signIn.start.error) {
    if (signInErrorMissing(signIn.start.error)) {
      return (
        <Steps>
          <li>
            <a href={GH_INSTALL_URL} target="_blank" rel="noopener noreferrer" className="text-violet hover:underline">
              Install the GitHub CLI
            </a>
          </li>
          <li>Come back and press Try again.</li>
        </Steps>
      )
    }
    return (
      <p role="alert" className="text-[13px] whitespace-pre-line text-danger">
        {signIn.start.error.message}
      </p>
    )
  }
  if (state?.status === 'failed') {
    return (
      <p role="alert" className="text-[13px] whitespace-pre-line text-danger">
        {state.error}
      </p>
    )
  }
  if (state?.status === 'done') return <SignInProgress>{state.login ? `Signed in as ${state.login}.` : 'Signed in.'}</SignInProgress>
  if (state?.status === 'pending') {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background py-3 pr-2 pl-5">
          <span data-testid="github-login-code" aria-label="One-time code" className="font-mono text-2xl tracking-widest text-foreground select-all">
            {state.code}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label="Copy code"
            onClick={() => copyText(state.code, 'Select the code and copy it')}
          >
            <CopyIcon aria-hidden="true" />
          </Button>
        </div>
        <SignInProgress>Waiting for GitHub…</SignInProgress>
      </div>
    )
  }
  return <SignInProgress>Starting…</SignInProgress>
}

/** Cancel while waiting (kills the login), Try again after a failure, and the GitHub page as the
 *  primary action while a code is showing — for when the browser did not open on its own. */
function GithubSignInFooter({ signIn, onClose }: { signIn: GithubSignIn; onClose: () => void }) {
  const state = signIn.state
  const failed = signIn.start.error !== null || state?.status === 'failed'
  if (failed) {
    return (
      <>
        <Button variant="outline" className="font-normal" onClick={onClose}>
          Close
        </Button>
        <Button className="font-normal" onClick={() => signIn.start.mutate()} disabled={signIn.start.isPending}>
          Try again
        </Button>
      </>
    )
  }
  return (
    <>
      <Button
        variant="outline"
        className="font-normal"
        onClick={() => {
          if (state?.status !== 'done') signIn.cancel.mutate()
          onClose()
        }}
      >
        {state?.status === 'done' ? 'Close' : 'Cancel'}
      </Button>
      {state?.status === 'pending' ? (
        <Button asChild className="font-normal">
          <a href={state.url} target="_blank" rel="noopener noreferrer">
            Open GitHub
          </a>
        </Button>
      ) : null}
    </>
  )
}

/** `$ command` with a copy button — the one shape every "run this in a terminal" step uses. */
function CommandBox({ command }: { command: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
      <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground select-all">
        <span className="text-soft-foreground select-none">$ </span>
        {command}
      </code>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label={`Copy ${command}`}
        onClick={() => copyText(command, 'Select the command and copy it')}
      >
        <CopyIcon aria-hidden="true" />
      </Button>
    </div>
  )
}

const input =
  'flex h-14 w-full items-center gap-3 rounded-xl border border-border bg-card px-5 transition-colors focus-within:border-primary focus-within:shadow-[0_0_0_4px_color-mix(in_srgb,var(--violet)_14%,transparent)]'

// ---- A1: a git project with an agent -----------------------------------------------------------

const SUGGESTIONS = [
  { icon: FlaskConicalIcon, label: 'Fix a failing test', task: 'Find a failing or flaky test and fix it.' },
  { icon: GitCommitHorizontalIcon, label: 'Summarize recent commits', task: 'Summarize the recent commits on this branch.' },
  { icon: FileTextIcon, label: 'Update the README', task: 'Update the README for the recent changes.' },
]

/** A repository with nothing in it yet has no tests to fix and no history to summarize. */
const FRESH_SUGGESTIONS = [
  { icon: FileTextIcon, label: 'Write a README', task: 'Write a README that explains what this project is for and how to run it.' },
  { icon: FlaskConicalIcon, label: 'Set up tests', task: 'Set up a test runner with one passing example test.' },
  { icon: GitCommitHorizontalIcon, label: 'Add a CI workflow', task: 'Add a CI workflow that installs dependencies and runs the tests on every push.' },
]

function Welcome() {
  const navigate = useNavigate()
  const health = useHealth()
  const repo = useRepo()
  const forge = health.data?.forge
  const github = useGithub({ limit: 3 }, forge?.kind === 'github' && forge.available !== false)
  const issues = github.data?.available ? github.data.issues.filter((item) => item.kind === 'issue').slice(0, 3) : []
  const [task, setTask] = React.useState('')
  const start = (text: string) => navigate(newTaskPrefillHref({ ref: text.trim() }))
  // Only the initial commit and no backlog: a fresh project, nothing to fix or summarize yet.
  const fresh = repo.data?.info !== undefined && repo.data.info !== null && repo.data.log.length <= 1 && issues.length === 0 && !github.isFetching
  const suggestions = fresh ? FRESH_SUGGESTIONS : SUGGESTIONS
  return (
    <Page title="What should we build?" slot="welcome" banner={<AnnouncementCard />}>
      <form
        className={cn(input, 'mt-7')}
        onSubmit={(event) => {
          event.preventDefault()
          start(task)
        }}
      >
        <input
          value={task}
          onChange={(event) => setTask(event.target.value)}
          placeholder="Describe a task for the agent…"
          aria-label="Describe a task for the agent"
          className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-soft-foreground"
        />
        <Button type="submit" size="icon" variant="ghost" aria-label="Continue to the composer" className="size-9 shrink-0">
          <ArrowRightIcon aria-hidden="true" />
        </Button>
      </form>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {suggestions.map(({ icon: Icon, label, task: text }) => (
          <button
            key={label}
            type="button"
            onClick={() => start(text)}
            className="inline-flex h-8 items-center gap-2 rounded-full px-3 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
      <ActivityStrip />
      <StartFrom fresh={fresh} issues={issues} colors={github.data?.labelColors ?? {}} />
    </Page>
  )
}

/** One new feature, announced above the page until the user tries or closes it. The right side
 *  is a small picture of the feature built from plain boxes: an app frame, a picked element, a
 *  note — nothing to load, correct in both themes. */
function AnnouncementCard() {
  const health = useHealth()
  const uiState = useWorkspaceUiState()
  const write = useOnboardingWrite()
  const navigate = useNavigate()
  const dismissed = uiState.data?.onboarding?.dismissedAnnouncements
  const item = uiState.data ? currentAnnouncement({ dismissed, designMode: health.data?.capabilities.designMode }) : null
  if (!item) return null
  const close = () => write({ dismissedAnnouncements: [...(dismissed ?? []), item.id] })
  return (
    <div data-slot="announcement" className="onboarding-announcement relative mb-14 flex w-full items-stretch overflow-hidden rounded-xl border text-left">
      <div className="flex min-w-0 flex-1 flex-col justify-center p-6">
        <span className="text-[11px] tracking-wide text-violet uppercase">New</span>
        <span className="mt-1 text-2xl font-light tracking-tight text-foreground">{item.title}</span>
        <p className="mt-2 max-w-sm text-[13px] text-muted-foreground">{item.description}</p>
        <Button
          size="sm"
          className="mt-5 self-start font-normal"
          onClick={() => {
            close()
            navigate(newTaskPrefillHref({ ref: item.hero.task }))
          }}
        >
          {item.hero.action}
          <ArrowRightIcon aria-hidden="true" />
        </Button>
      </div>
      <DesignModePicture />
      <button
        type="button"
        onClick={close}
        aria-label={`Close ${item.title} announcement`}
        className="absolute top-3 right-3 grid size-7 place-items-center rounded-full text-soft-foreground hover:text-foreground"
      >
        <XIcon className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}

/** A tiny app window with one element picked and a note beside it. */
function DesignModePicture() {
  return (
    <div className="onboarding-picture hidden w-64 shrink-0 items-end justify-center pt-6 pr-6 sm:flex" aria-hidden="true">
      <div className="w-full rounded-t-lg border border-b-0 border-border bg-background p-3 shadow-[0_-12px_40px_-20px_var(--violet)]">
        <div className="flex gap-1.5">
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        </div>
        <div className="mt-3 h-2 w-2/3 rounded bg-muted" />
        <div className="mt-2 h-2 w-1/2 rounded bg-muted" />
        <div className="relative mt-4 flex items-center gap-2">
          <span className="relative h-6 w-16 rounded-md border border-violet bg-violet/15 outline-2 outline-offset-2 outline-violet/40">
            <span className="absolute -top-1 -left-1 size-1.5 rounded-[2px] bg-violet" />
            <span className="absolute -top-1 -right-1 size-1.5 rounded-[2px] bg-violet" />
            <span className="absolute -bottom-1 -left-1 size-1.5 rounded-[2px] bg-violet" />
            <span className="absolute -right-1 -bottom-1 size-1.5 rounded-[2px] bg-violet" />
          </span>
          <span className="h-6 w-10 rounded-md bg-muted" />
          <span className="absolute top-7 left-6 rounded-md rounded-tl-sm border border-border bg-card px-2 py-1 text-[10px] whitespace-nowrap text-foreground shadow-md">
            Make this button larger
          </span>
        </div>
        <div className="mt-9 h-2 w-3/4 rounded bg-muted" />
      </div>
    </div>
  )
}

/** The optional setup that is left, derived each render; only "hidden" is stored. */
export function useOnboardingSetup() {
  const config = useConfig()
  const health = useHealth()
  const repo = useRepo()
  const uiState = useWorkspaceUiState()
  const write = useOnboardingWrite()
  const lifecycle = config.data?.worktreeLifecycle
  const steps = pendingSetupSteps({
    worktreeSetupConfigured: config.data ? (lifecycle?.afterCreate.length ?? 0) > 0 : undefined,
    forge: health.data?.forge,
  })
  const info = repo.data?.info
  // A committed repository with no remote at all: GitHub never comes up unless we offer it.
  // Publishing is refused in a single-project workspace, so the pill never offers it there.
  const unpublished = info !== undefined && info !== null && !info.remote && health.data?.capabilities.singleProject !== true
  const dismissed = uiState.data?.onboarding?.setupDismissed === true
  const dismiss = React.useCallback(() => write({ setupDismissed: true }), [write])
  return { steps, unpublished, folder: info ? folderName(info.root) : '', dismissed: dismissed || !uiState.data, dismiss }
}

const STEP_ICON: Record<SetupStep['id'], IconComponent> = {
  worktrees: PackageIcon,
  github: GithubIcon,
}

const ACTIVITY_DAYS = 30
const ACTIVITY_MAX_SQUARES = 6

/** Tasks per day over the last month — the project's pulse. Shown only once there is history
 *  (an empty month of bars would say "nothing happens here"), so a brand-new project never sees it. */
function ActivityStrip() {
  const runs = useRuns()
  const days = React.useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const buckets = Array.from({ length: ACTIVITY_DAYS }, (_, i) => {
      const date = new Date(today)
      date.setDate(today.getDate() - (ACTIVITY_DAYS - 1 - i))
      return { date, count: 0 }
    })
    const first = buckets[0]?.date.getTime() ?? 0
    for (const run of runs.data ?? []) {
      const at = new Date(run.createdAt)
      at.setHours(0, 0, 0, 0)
      const index = Math.round((at.getTime() - first) / 86_400_000)
      const bucket = buckets[index]
      if (bucket) bucket.count += 1
    }
    return buckets
  }, [runs.data])
  const total = days.reduce((sum, day) => sum + day.count, 0)
  if (total === 0) return null
  const max = Math.max(1, ...days.map((day) => day.count))
  // One square per task, up to a column of six; busier days scale down so the strip stays short.
  const squares = (count: number) => (count === 0 ? 0 : Math.max(1, Math.round((count / max) * Math.min(max, ACTIVITY_MAX_SQUARES))))
  const label = (date: Date) => date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return (
    <div data-slot="activity-strip" className="mt-12 w-full">
      <div className="mb-3 flex items-baseline justify-between text-[13px]">
        <span className="text-soft-foreground">Activity</span>
        <span className="text-soft-foreground">
          {total} {total === 1 ? 'task' : 'tasks'} in the last {ACTIVITY_DAYS} days
        </span>
      </div>
      <TooltipProvider delayDuration={100}>
        <div className="flex items-end justify-between" role="img" aria-label={`${total} tasks in the last ${ACTIVITY_DAYS} days`}>
          {days.map((day) => (
            <Tooltip key={day.date.toISOString()}>
              <TooltipTrigger asChild>
                <span className="flex flex-col-reverse gap-1 py-1">
                  {Array.from({ length: Math.max(1, squares(day.count)) }, (_, i) => (
                    <span key={i} className={cn('size-2.5 rounded-[3px]', day.count > 0 ? 'bg-violet' : 'bg-muted')} />
                  ))}
                </span>
              </TooltipTrigger>
              <TooltipContent>{`${label(day.date)}: ${day.count} ${day.count === 1 ? 'task' : 'tasks'}`}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TooltipProvider>
      <div className="mt-2 flex justify-between font-mono text-[10.5px] text-soft-foreground">
        {days.filter((_, i) => i % 7 === 1 || i === ACTIVITY_DAYS - 1).map((day) => (
          <span key={day.date.toISOString()}>{label(day.date)}</span>
        ))}
      </div>
    </div>
  )
}

/** Something real to start from: the repository's open issues when GitHub answers, else the
 *  project's skills. Both are one click into the composer; nothing is stored. */
function StartFrom({ fresh, issues, colors }: { fresh: boolean; issues: GithubItem[]; colors: Record<string, string> }) {
  const repo = useRepo()
  const commits = repo.data?.info && !fresh ? repo.data.log.slice(0, 3) : []
  const skills = useSkills(issues.length === 0 && commits.length === 0)
  const picks = pickSkills(skills.data ?? [])
  if (issues.length > 0) {
    return (
      <StartSection label="Or pick up an issue" slot="issues">
        <ul className="w-full divide-y divide-border rounded-xl border border-border bg-card p-1.5 text-left">
          {issues.map((item) => (
            <li key={item.number} className="first:[&>a]:rounded-t-lg last:[&>a]:rounded-b-lg">
              <Link
                to={newTaskPrefillHref({ ref: githubTaskRef(item) })}
                className="group flex flex-col gap-1.5 px-3 py-2.5 transition-colors hover:bg-muted"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-[14px] text-foreground">{item.title}</span>
                  <ArrowRightIcon className="ml-auto size-3.5 shrink-0 text-soft-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-soft-foreground">
                  <span className="font-mono">#{item.number}</span>
                  <span>{item.author}</span>
                  <span>{shortAge(item.createdAt)} ago</span>
                  {item.comments > 0 ? (
                    <span className="inline-flex items-center gap-1">
                      <MessageSquareIcon className="size-3" aria-hidden="true" />
                      {item.comments}
                    </span>
                  ) : null}
                  {item.labels.map((label) => (
                    <span key={label} style={labelChipStyle(colors[label])} className="rounded-full border px-1.5 py-px text-[10px]">
                      {label}
                    </span>
                  ))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </StartSection>
    )
  }
  if (commits.length > 0) {
    return (
      <StartSection label="Or continue recent work" slot="commits">
        <ul className="w-full divide-y divide-border rounded-xl border border-border bg-card p-1.5 text-left">
          {commits.map((commit) => (
            <li key={commit.hash} className="first:[&>a]:rounded-t-lg last:[&>a]:rounded-b-lg">
              <Link
                to={newTaskPrefillHref({ ref: `Continue the work from commit ${commit.hash} (${commit.subject}).` })}
                className="group flex flex-col gap-1 px-3 py-2.5 transition-colors hover:bg-muted"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-[14px] text-foreground">{commit.subject}</span>
                  <ArrowRightIcon className="ml-auto size-3.5 shrink-0 text-soft-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
                </span>
                <span className="flex items-center gap-2 text-[11.5px] text-soft-foreground">
                  <span className="font-mono">{commit.hash}</span>
                  <span>{commit.author}</span>
                  <span>{commit.when}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </StartSection>
    )
  }
  if (picks.length > 0) {
    return (
      <StartSection label="Or start with a skill" slot="skills">
        <div className="flex flex-wrap justify-center gap-2">
          {picks.map((skill) => (
            <Link key={skill.name} to={newTaskPrefillHref({ skill: skill.name })} className={chip} title={skill.description}>
              {skill.name}
            </Link>
          ))}
        </div>
      </StartSection>
    )
  }
  return null
}

function StartSection({ label, slot, children }: { label: string; slot: string; children: React.ReactNode }) {
  return (
    <div data-slot="start-from" data-start-from={slot} className="mt-14 flex w-full flex-col items-center gap-3">
      <div className="text-[13px] text-soft-foreground">{label}</div>
      {children}
    </div>
  )
}

/** Up to four skills, the project's own before the user's global ones. */
function pickSkills<T extends { name: string; source: string }>(skills: readonly T[]): T[] {
  const own = skills.filter((skill) => skill.source !== 'global' && skill.source !== 'builtin')
  const rest = skills.filter((skill) => skill.source === 'global')
  return [...own, ...rest].slice(0, 4)
}

/** Publish a local repository to a new PRIVATE GitHub repository. */
export function PublishGithubDialog({ folder, onOpenChange }: { folder: string; onOpenChange: (open: boolean) => void }) {
  const { projectId } = useProjectScope()
  const owners = useGithubOwners()
  const publish = usePublishProjectGithub()
  const available = owners.data?.available === true ? owners.data.owners : null
  const [owner, setOwner] = React.useState<string | null>(null)
  const [name, setName] = React.useState(() => repoName(folder))
  const chosen = owner ?? available?.[0]?.login ?? ''
  const submit = () => {
    if (publish.isPending || !chosen || !name.trim()) return
    publish.mutate(
      { projectId: projectId ?? 'default', owner: chosen, name: name.trim() },
      {
        onSuccess: ({ slug }) => {
          onOpenChange(false)
          toast(`Published to ${slug}`)
        },
      },
    )
  }
  const connected = available !== null
  const needsSignIn = !owners.isPending && !connected
  const signIn = useGithubSignIn(needsSignIn, () => void owners.refetch())
  // `gh` signed in, yet it still lists no account (a token without the scope, GitHub down):
  // say why instead of spinning on "Signed in." forever.
  const noOwnersReason =
    signIn.state?.status === 'done' && !owners.isFetching && owners.data?.available === false ? owners.data.reason : null
  return (
    <OnboardingDialog
      title="Publish to GitHub"
      description={
        connected ? 'A new private repository. You can make it public on GitHub later.' : noOwnersReason ? 'Signed in, but GitHub listed no accounts.' : githubSignInLine(signIn)
      }
      onOpenChange={onOpenChange}
      onSubmit={connected ? submit : undefined}
      footer={
        noOwnersReason ? (
          <>
            <Button variant="outline" className="font-normal" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button className="font-normal" onClick={() => void owners.refetch()}>
              Check again
            </Button>
          </>
        ) : connected ? (
          <>
            <Button variant="outline" className="font-normal" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button className="font-normal" onClick={submit} disabled={publish.isPending || !chosen || !name.trim()}>
              {publish.isPending ? 'Publishing…' : 'Publish'}
            </Button>
          </>
        ) : (
          <GithubSignInFooter signIn={signIn} onClose={() => onOpenChange(false)} />
        )
      }
    >
      {owners.isPending ? (
        <p className="text-[13px] text-soft-foreground">Checking GitHub…</p>
      ) : noOwnersReason ? (
        <p role="alert" className="text-[13px] text-danger">
          {noOwnersReason}
        </p>
      ) : !connected ? (
        <GithubSignInBody signIn={signIn} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Owner">
            {available.map((entry) => (
              <button
                key={entry.login}
                type="button"
                role="radio"
                aria-checked={entry.login === chosen}
                onClick={() => setOwner(entry.login)}
                className={cn(
                  'inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] transition-colors',
                  entry.login === chosen ? 'border-primary text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {entry.login}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1 rounded-lg border border-input bg-background px-3 font-mono text-[13px] focus-within:border-ring">
            <span className="text-soft-foreground">{chosen}/</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="Repository name"
              className="h-9 min-w-0 flex-1 bg-transparent text-foreground outline-none"
            />
          </label>
        </div>
      )}
      {publish.error ? (
        <p role="alert" className="mt-3 text-xs whitespace-pre-line text-danger">
          {publish.error.message}
        </p>
      ) : null}
    </OnboardingDialog>
  )
}

/** After the first task, what is left of setup is one small pill above the table. */
export function SetupPill() {
  const { steps, unpublished, folder, dismissed, dismiss } = useOnboardingSetup()
  const [publishing, setPublishing] = React.useState(false)
  const next = steps[0]
  if (dismissed || (next === undefined && !unpublished)) return null
  const Icon = next ? STEP_ICON[next.id] : GithubIcon
  const inner = (
    <>
      <Icon className="size-3.5 text-muted-foreground" aria-hidden={true} />
      {next ? next.label : 'Publish to GitHub'}
      <ArrowRightIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
    </>
  )
  const action = 'inline-flex h-7 items-center gap-1.5 rounded-full bg-muted px-3 text-foreground'
  return (
    <div
      data-onboarding=""
      data-slot="setup-pill"
      className="mb-3 inline-flex items-center gap-2 self-start rounded-full border border-border bg-card py-1 pr-1 pl-3 text-[13px]"
    >
      <span className="text-soft-foreground">Setup</span>
      {next ? (
        <Link to={next.to} className={action}>
          {inner}
        </Link>
      ) : (
        <button type="button" className={action} onClick={() => setPublishing(true)} data-setup-step="publish">
          {inner}
        </button>
      )}
      <button type="button" onClick={dismiss} aria-label="Hide setup" className="grid size-7 place-items-center rounded-full text-soft-foreground hover:text-foreground">
        <XIcon className="size-3.5" aria-hidden="true" />
      </button>
      {publishing ? <PublishGithubDialog folder={folder} onOpenChange={setPublishing} /> : null}
    </div>
  )
}

// ---- A2: nothing signed in -------------------------------------------------------------------

function SignInToAgent() {
  const providers = useProviderStatus()
  const refresh = useRefreshProviderStatus()
  const connect = useConnectAgentAccount()
  const write = useOnboardingWrite()
  const rows = agentSetupRows(providers.data)
  // Which agent's login is open in a terminal: while set, the status is re-probed every few
  // seconds so the page moves on by itself the moment the login lands — no "Check again" to find.
  const [waitingFor, setWaitingFor] = React.useState<ProviderId | null>(null)
  const [fallback, setFallback] = React.useState<{ provider: ProviderId; message: string } | null>(null)
  const refreshMutate = refresh.mutate
  // Always re-probe slowly while this page is up — "cezar checks on its own" has to be true for
  // someone who installed and signed in from a terminal without pressing anything here.
  React.useEffect(() => {
    const timer = window.setInterval(() => refreshMutate(), SIGN_IN_IDLE_POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshMutate])
  React.useEffect(() => {
    if (!waitingFor) return
    let ticks = 0
    const timer = window.setInterval(() => {
      ticks += 1
      if (ticks > SIGN_IN_POLL_TICKS) {
        window.clearInterval(timer)
        setWaitingFor(null)
        return
      }
      refreshMutate()
    }, SIGN_IN_POLL_MS)
    return () => window.clearInterval(timer)
  }, [waitingFor, refreshMutate])
  const signIn = (provider: ProviderId) => {
    setFallback(null)
    connect.mutate(
      { provider },
      {
        onSuccess: (result) => {
          if (result.opened) setWaitingFor(provider)
          else refreshMutate()
        },
        onError: (error: Error) => setFallback({ provider, message: error.message }),
      },
    )
  }
  return (
    <Page title="Sign in to an agent" slot="sign-in" step="agent" why="cezar runs the coding agent you already use. No API key needed.">
      <div className="mt-7 flex w-full flex-col gap-3 text-left">
        {/* Every agent switched off leaves no row to sign in to: say so, and where to turn one on. */}
        {rows.length === 0 ? (
          <div data-slot="agents-off" className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-[14px] text-foreground">All agents are turned off.</span>
            <Button asChild size="sm" className="font-normal">
              <Link to="/settings/agents#providers">Turn one on</Link>
            </Button>
          </div>
        ) : null}
        {rows.map((row) => {
          const waiting = waitingFor === row.provider
          const failed = fallback?.provider === row.provider ? fallback.message : null
          return (
            <div key={row.provider} data-slot="agent-row" data-state={row.state} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] text-foreground">{row.label}</div>
                  <div className="text-[13px] text-muted-foreground">
                    {waiting ? 'Finish in Terminal' : row.state === 'missing' ? 'Not installed' : 'Installed, not signed in'}
                  </div>
                </div>
                {row.state === 'signed-out' ? (
                  waiting ? (
                    <LoaderCircleIcon className="size-4 shrink-0 text-violet motion-safe:animate-spin" aria-label="Waiting for sign-in" />
                  ) : (
                    <Button className="font-normal" onClick={() => signIn(row.provider)} disabled={connect.isPending}>
                      Sign in
                    </Button>
                  )
                ) : null}
              </div>
              {row.state === 'signed-out' && !waiting && !failed ? (
                <p className="mt-3 text-[13px] text-soft-foreground">Opens the login in Terminal.</p>
              ) : null}
              {waiting ? <p className="mt-3 text-[13px] text-soft-foreground">This page continues by itself.</p> : null}
              {failed ? (
                <div className="mt-3 flex flex-col gap-3">
                  <p className="text-[13px] text-muted-foreground">{failed}</p>
                  <Steps>
                    <li>
                      <span className="text-foreground">Open Terminal and paste:</span>
                      <div className="mt-2">
                        <CommandBox command={row.command} />
                      </div>
                    </li>
                    <li>Come back. cezar checks by itself.</li>
                  </Steps>
                </div>
              ) : null}
              {row.state === 'missing' ? (
                <div className="mt-3 flex flex-col gap-3">
                  <Steps>
                    <li>
                      <span className="text-foreground">Open Terminal and paste:</span>
                      <div className="mt-2">
                        <CommandBox command={row.command} />
                      </div>
                    </li>
                    <li>
                      <span className="text-foreground">Then sign in:</span>
                      <div className="mt-2">
                        <CommandBox command={row.login} />
                      </div>
                    </li>
                    <li>Come back. cezar checks by itself.</li>
                  </Steps>
                  <p className="text-[12.5px] text-soft-foreground">
                    Needs Node.js.{' '}
                    <a href="https://nodejs.org" target="_blank" rel="noopener noreferrer" className="text-violet hover:underline">
                      Get it
                    </a>
                  </p>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      <div className="mt-7 flex flex-wrap justify-center gap-5">
        <button type="button" onClick={() => refreshMutate()} disabled={refresh.isPending} className={quiet}>
          {refresh.isPending ? 'Checking…' : 'Check again'}
        </button>
        <Link to="/settings/agents" className={quiet}>
          Other agents
        </Link>
        <button type="button" onClick={() => write({ agentCheckSkipped: true })} className={quiet}>
          Continue anyway
        </button>
      </div>
    </Page>
  )
}

const SIGN_IN_POLL_MS = 3_000
const SIGN_IN_IDLE_POLL_MS = 10_000
const SIGN_IN_POLL_TICKS = 60

// ---- B1: no git repository -------------------------------------------------------------------

/**
 * The root of the project on screen. Health is workspace-level and always names the folder cezar
 * booted in, so a second registered folder has to be looked up in the registry by its scope id;
 * health is only the fallback for the boot project while the registry loads.
 */
function useScopedProjectRoot(): string | undefined {
  const { projectId } = useProjectScope()
  const projects = useProjects()
  const health = useHealth()
  const id = projectId ?? projects.data?.bootProject
  const entry = projects.data?.projects.find((project) => project.id === id)
  if (entry) return entry.root
  return projectId === null || projectId === health.data?.bootProject ? health.data?.repoRoot : undefined
}

function PickProject() {
  const health = useHealth()
  const singleProject = health.data?.capabilities.singleProject === true
  const root = useScopedProjectRoot()
  const folder = root ? folderName(root) : 'This folder'
  const [initOpen, setInitOpen] = React.useState(false)
  return (
    <Page
      title="Pick a project"
      slot="pick-project"
      step="project"
      why="Tasks run inside a git repository, each in its own worktree."
      subtitle={
        <>
          <span className="font-mono">{folder}</span> isn’t a git repository.
          {/* A single-project workspace changes no project, so the server refuses git-init. */}
          {singleProject ? null : (
            <>
              {' '}
              <button type="button" onClick={() => setInitOpen(true)} className="text-violet hover:underline">
                Initialize git here
              </button>
            </>
          )}
        </>
      }
    >
      {singleProject ? null : <ProjectChoices />}
      {initOpen ? <InitGitDialog folder={folder} onOpenChange={setInitOpen} /> : null}
    </Page>
  )
}

function ProjectChoices() {
  const suggestions = useRepoSuggestions()
  const owners = useGithubOwners()
  const register = useRegisterProject()
  const navigate = useGlobalNavigate()
  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(0)
  const [dialog, setDialog] = React.useState<'new' | 'clone' | 'folder' | 'connect' | null>(null)
  const repos = (suggestions.data?.repos ?? []).filter((repo) =>
    repo.name.toLowerCase().includes(query.trim().toLowerCase()),
  )
  const shown = repos.slice(0, 6)
  // Unknown while the probe runs: the link stays "Clone" rather than flashing "Connect".
  const githubMissing = owners.data !== undefined && !owners.data.available
  // Nothing on disk to offer (not a search miss): the three ways in become the page's actions.
  const nothingFound = !suggestions.isPending && (suggestions.data?.repos.length ?? 0) === 0

  const open = (repo: RepoSuggestion) => {
    if (repo.projectId) {
      navigate(`/p/${encodeURIComponent(repo.projectId)}/`)
      return
    }
    register.mutate(repo.path, {
      onSuccess: ({ project }) => navigate(`/p/${encodeURIComponent(project.id)}/`),
      onError: (error: Error) => toast(error.message, { tone: 'danger' }),
    })
  }
  const openDialog = (kind: 'new' | 'clone' | 'folder') => {
    setDialog(kind)
    trackAddProjectOpened(kind)
  }

  return (
    <>
      {nothingFound ? (
        <div data-slot="no-repos" className="mt-8 grid w-full gap-3 sm:grid-cols-3">
          <ChoiceTile
            title="New project"
            description="An empty repository here, or a new private one on GitHub."
            recommended={githubMissing}
            onClick={() => openDialog('new')}
            picture={
              <span className="grid size-12 place-items-center rounded-lg border border-dashed border-muted-foreground/60">
                <span className="relative size-4">
                  <span className="absolute top-1/2 left-0 h-0.5 w-full -translate-y-1/2 rounded bg-muted-foreground" />
                  <span className="absolute top-0 left-1/2 h-full w-0.5 -translate-x-1/2 rounded bg-muted-foreground" />
                </span>
              </span>
            }
          />
          {githubMissing ? (
            <ChoiceTile
              title="Connect GitHub"
              description="Sign in to the GitHub CLI to clone and publish."
              onClick={() => setDialog('connect')}
              picture={<GithubIcon className="size-9 text-muted-foreground" aria-hidden={true} />}
            />
          ) : (
            <ChoiceTile
              title="Clone from GitHub"
              description="Any repository you can read, by URL or owner/name."
              recommended
              onClick={() => openDialog('clone')}
              picture={
                <span className="flex w-16 flex-col gap-1.5">
                  <span className="flex items-center gap-1.5 rounded-md border border-violet bg-violet/15 px-1.5 py-1"><span className="size-1.5 rounded-full bg-violet" /><span className="h-1 flex-1 rounded bg-violet/60" /></span>
                  <span className="flex items-center gap-1.5 rounded-md border border-border px-1.5 py-1"><span className="size-1.5 rounded-full bg-muted-foreground/50" /><span className="h-1 w-3/4 rounded bg-muted" /></span>
                  <span className="flex items-center gap-1.5 rounded-md border border-border px-1.5 py-1"><span className="size-1.5 rounded-full bg-muted-foreground/50" /><span className="h-1 w-1/2 rounded bg-muted" /></span>
                </span>
              }
            />
          )}
          <ChoiceTile
            title="Open a folder"
            description="A repository that already lives on this disk."
            onClick={() => openDialog('folder')}
            picture={
              <span className="flex w-16 flex-col gap-1.5">
                <span className="h-2 w-10 rounded-sm bg-muted-foreground/70" />
                <span className="ml-3 h-1.5 w-9 rounded bg-muted" />
                <span className="ml-3 h-1.5 w-7 rounded bg-muted" />
                <span className="ml-3 h-1.5 w-8 rounded bg-muted" />
              </span>
            }
          />
        </div>
      ) : (
        <>
        <div className="mt-7 w-full rounded-xl border border-border bg-card p-1.5 text-left">
          <label className="flex h-11 items-center gap-2 rounded-lg border border-input bg-background px-3 focus-within:border-ring">
            <SearchIcon className="size-4 text-soft-foreground" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setActive((index) => Math.min(index + 1, shown.length - 1))
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setActive((index) => Math.max(index - 1, 0))
                } else if (event.key === 'Enter') {
                  const repo = shown[active]
                  if (repo) open(repo)
                }
              }}
              placeholder="Search repositories"
              aria-label="Search repositories"
              className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-soft-foreground"
            />
          </label>
          <ul role="listbox" aria-label="Repositories" className="mt-1">
            {suggestions.isPending ? (
              <li className="px-3 py-2.5 text-[13px] text-soft-foreground">Looking for repositories…</li>
            ) : shown.length === 0 ? (
              <li className="px-3 py-2.5 text-[13px] text-soft-foreground">No repositories found</li>
            ) : (
              shown.map((repo, index) => (
                <li key={repo.path} role="option" aria-selected={index === active}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(index)}
                    onClick={() => open(repo)}
                    disabled={register.isPending}
                    className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left', index === active && 'bg-muted')}
                  >
                    <span className="truncate text-[15px] text-foreground">{repo.name}</span>
                    <span className="ml-auto truncate font-mono text-[11.5px] text-soft-foreground">{parentPath(repo.path)}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
        <div className="mt-5 flex flex-wrap justify-center gap-6">
          <button type="button" className={quiet} onClick={() => openDialog('new')}>
            <PlusIcon className="size-3.5" aria-hidden="true" />
            New project
          </button>
          {githubMissing ? (
            <button type="button" className={quiet} onClick={() => setDialog('connect')} data-slot="connect-github">
              <GithubIcon className="size-3.5" aria-hidden={true} />
              Connect GitHub
            </button>
          ) : (
            <button type="button" className={quiet} onClick={() => openDialog('clone')}>
              <GithubIcon className="size-3.5" aria-hidden={true} />
              Clone from GitHub
            </button>
          )}
          <button type="button" className={quiet} onClick={() => openDialog('folder')}>
            <FolderIcon className="size-3.5" aria-hidden="true" />
            Browse…
          </button>
        </div>

        </>
      )}
      {dialog === 'new' ? (
        <DialogErrorBoundary label="New project" onError={() => setDialog(null)}>
          <CreateProjectDialog open onOpenChange={(next) => !next && setDialog(null)} />
        </DialogErrorBoundary>
      ) : null}
      {dialog === 'clone' ? (
        <DialogErrorBoundary label="Clone from GitHub" onError={() => setDialog(null)}>
          <CloneProjectDialog open onOpenChange={(next) => !next && setDialog(null)} />
        </DialogErrorBoundary>
      ) : null}
      {dialog === 'folder' ? (
        <DialogErrorBoundary label="Open local folder" onError={() => setDialog(null)}>
          <AddProjectDialog open onOpenChange={(next) => !next && setDialog(null)} />
        </DialogErrorBoundary>
      ) : null}
      {dialog === 'connect' ? <ConnectGithubDialog onOpenChange={(next) => !next && setDialog(null)} /> : null}
    </>
  )
}

function ChoiceTile({
  title,
  description,
  picture,
  recommended = false,
  onClick,
}: {
  title: string
  description: string
  picture: React.ReactNode
  recommended?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-recommended={recommended || undefined}
      className={cn(
        'group relative flex flex-col items-center gap-4 rounded-xl border px-4 pt-7 pb-5 text-center transition-colors',
        recommended ? 'onboarding-announcement' : 'border-border bg-card hover:border-muted-foreground',
      )}
    >
      {recommended ? <span className="absolute top-3 right-3 text-[11px] tracking-wide text-violet uppercase">Start here</span> : null}
      <span className="grid h-16 place-items-center" aria-hidden="true">
        {picture}
      </span>
      <span className="flex flex-col gap-1">
        <span className="text-lg font-light text-foreground">{title}</span>
        <span className="text-[12.5px] text-muted-foreground">{description}</span>
      </span>
    </button>
  )
}

/** Cloning needs a signed-in `gh`. cezar signs it in; the dialog closes itself when GitHub approves. */
export function ConnectGithubDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange])
  const signIn = useGithubSignIn(true, (login) => {
    toast(login ? `GitHub connected as ${login}` : 'GitHub connected')
    close()
  })
  return (
    <OnboardingDialog
      title="Connect GitHub"
      description={githubSignInLine(signIn)}
      onOpenChange={onOpenChange}
      footer={<GithubSignInFooter signIn={signIn} onClose={close} />}
    >
      <GithubSignInBody signIn={signIn} />
    </OnboardingDialog>
  )
}

/** cezar runs the commands itself; the dialog only says which. */
function InitGitDialog({ folder, onOpenChange }: { folder: string; onOpenChange: (open: boolean) => void }) {
  const { projectId } = useProjectScope()
  const init = useInitProjectGit()
  const initialize = () => {
    if (init.isPending) return
    init.mutate(projectId ?? 'default', {
      onSuccess: () => {
        onOpenChange(false)
        toast(`Initialized git in ${folder}`)
      },
    })
  }
  return (
    <OnboardingDialog
      title={`Initialize git in ${folder}`}
      description="Git keeps a history of your files. cezar runs this for you and uploads nothing. node_modules and .env files stay out."
      onOpenChange={onOpenChange}
      onSubmit={initialize}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="font-normal">
            Cancel
          </Button>
          <Button onClick={initialize} disabled={init.isPending} className="font-normal">
            {init.isPending ? 'Initializing…' : 'Initialize'}
          </Button>
        </>
      }
    >
      <pre className="rounded-lg border border-border bg-background px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
        {'$ git init -b main\n$ git add -A\n$ git commit -m "Initial commit"'}
      </pre>
      {init.error ? (
        <p role="alert" className="mt-3 text-xs whitespace-pre-line text-danger">
          {init.error.message}
        </p>
      ) : null}
    </OnboardingDialog>
  )
}

function folderName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root
}

/** A folder name as GitHub would accept it: spaces become dashes, anything else invalid goes. */
export function repoName(folder: string): string {
  return folder.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 100) || 'project'
}

function parentPath(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.join('/').replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~')
}

// ---- Coming back after a while -----------------------------------------------------------------

/**
 * Records the visit and answers which sidebar items wear a "new" dot (spec
 * 2026-10-26-first-run-onboarding, "Coming back"). Called by the shell, so landing on any page
 * counts as a visit; opening a feature's page counts as having seen it.
 */
export function useFeatureNews(pathname: string): ReadonlySet<string> {
  const uiState = useWorkspaceUiState()
  const health = useHealth()
  const write = useOnboardingWrite()
  const onboarding = uiState.data?.onboarding
  const loaded = uiState.data !== undefined
  const recorded = React.useRef(false)
  React.useEffect(() => {
    if (!loaded || recorded.current) return
    recorded.current = true
    const patch = visitPatch(onboarding, Date.now())
    if (patch) write(patch)
  }, [loaded, onboarding, write])
  const designMode = health.data?.capabilities.designMode
  const automations = health.data?.capabilities.automations
  const paths = React.useMemo(
    () => (loaded ? newFeaturePaths(onboarding, { designMode, automations }, Date.now()) : new Map<string, string>()),
    [loaded, onboarding, designMode, automations],
  )
  React.useEffect(() => {
    const opened = [...paths].filter(([path]) => pathname === path || pathname.startsWith(`${path}/`)).map(([, id]) => id)
    if (opened.length > 0) write({ dismissedAnnouncements: [...(onboarding?.dismissedAnnouncements ?? []), ...opened].slice(-50) })
  }, [pathname, paths, onboarding, write])
  return React.useMemo(
    () => new Set(NAV_ITEMS.filter((item) => [...paths.keys()].some((path) => navOwnsPath(item.to, path))).map((item) => item.to)),
    [paths],
  )
}

/**
 * After two weeks away (spec 2026-10-26-first-run-onboarding, "Coming back"): one greeting line
 * above the task table, the way Gumloop, Causal and AI Studio greet on their home pages. The task
 * table and the sidebar already show the user's work, so the line only points at what waits on
 * them; what changed sits behind one pill that opens "What's new".
 */
export function WelcomeBack({ runs }: { runs: readonly RunRecord[] }) {
  const uiState = useWorkspaceUiState()
  const health = useHealth()
  const write = useOnboardingWrite()
  const [now] = React.useState(() => Date.now())
  const [showNews, setShowNews] = React.useState(false)
  const since = welcomeBackSince(uiState.data?.onboarding, now)
  if (!since) return null
  const waiting = tasksNeedingYou(runs)
  const news = announcementsSince(since, {
    designMode: health.data?.capabilities.designMode,
    automations: health.data?.capabilities.automations,
  })
  const month = new Date(since).toLocaleString('en', { month: 'long' })
  const first = waiting[0]
  const sentence = welcomeBackSentence(waiting, news.length)
  if (!sentence) return null
  return (
    <section
      data-onboarding=""
      data-slot="welcome-back"
      aria-label="Welcome back"
      className="onboarding-announcement relative mb-4 flex flex-col gap-4 rounded-xl border py-5 pr-14 pl-6 sm:flex-row sm:items-center sm:gap-8 sm:pr-20"
    >
      <div className="min-w-0 sm:flex-1">
        <h2 className="text-xl font-light tracking-tight text-foreground">Welcome back</h2>
        <p className="mt-1 text-[14px] text-muted-foreground">{sentence}</p>
      </div>
      {/* One column per button, all as wide as the widest: the pair reads as one choice. */}
      <div className="grid shrink-0 auto-cols-fr grid-flow-col gap-2">
        {first ? (
          <Button asChild size="sm" className="w-full font-normal">
            <Link to={`/tasks/${first.id}`} data-slot="welcome-back-waiting">
              {waiting.length > 1 ? 'Open tasks' : first.status === 'review' ? 'Review task' : 'Open task'}
            </Link>
          </Button>
        ) : null}
        {news.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full font-normal"
            data-slot="welcome-back-news"
            onClick={() => {
              setShowNews(true)
              write({ whatsNewSeenAt: new Date().toISOString() })
            }}
          >
            See what’s new
          </Button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => write({ welcomeBackClosedAt: new Date().toISOString() })}
        aria-label="Close welcome back"
        className="absolute top-3 right-3 grid size-8 place-items-center rounded-full text-soft-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <XIcon className="size-4" aria-hidden="true" />
      </button>
      {showNews ? (
        <WhatsNewDialog
          items={news}
          description={`${news.length} ${news.length === 1 ? 'change' : 'changes'} since ${month}.`}
          onOpenChange={setShowNews}
        />
      ) : null}
    </section>
  )
}

/**
 * The sidebar's permanent way into "What's new" (Linear, Riverside): a quiet row above the
 * footer, with a dot while something shipped since the user last opened it.
 */
export function WhatsNewNavItem() {
  const uiState = useWorkspaceUiState()
  const health = useHealth()
  const write = useOnboardingWrite()
  const [open, setOpen] = React.useState(false)
  const [now] = React.useState(() => Date.now())
  const capabilities = { designMode: health.data?.capabilities.designMode, automations: health.data?.capabilities.automations }
  const items = recentAnnouncements(capabilities, now)
  if (!uiState.data || items.length === 0) return null
  const unseen = whatsNewHasUnseen(uiState.data.onboarding, capabilities, now)
  return (
    <>
      <button
        type="button"
        data-slot="whats-new"
        onClick={() => {
          setOpen(true)
          write({ whatsNewSeenAt: new Date().toISOString() })
        }}
        className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <GiftIcon className="size-4 shrink-0" aria-hidden="true" />
        What’s new
        {unseen ? (
          <span className="ml-auto flex items-center">
            <span className="size-1.5 rounded-full bg-violet" aria-hidden="true" />
            <span className="sr-only">Unread</span>
          </span>
        ) : null}
      </button>
      {open ? <WhatsNewDialog items={items} description="Recent changes in cezar." onOpenChange={setOpen} /> : null}
    </>
  )
}

/**
 * One feature per page, a picture of it on top (HubSpot, Relume, Lovable): the title, one
 * sentence, and a way to the feature when it has a place. Arrow keys page, ⌘↵ goes on.
 */
function WhatsNewDialog({
  items,
  description,
  onOpenChange,
}: {
  items: readonly Announcement[]
  description: string
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const [index, setIndex] = React.useState(0)
  const item = items[Math.min(index, items.length - 1)]
  if (!item) return null
  const last = index >= items.length - 1
  const next = () => (last ? onOpenChange(false) : setIndex(index + 1))
  const actionLabel = item.to ? item.action : item.hero?.action
  const go = () => {
    onOpenChange(false)
    if (item.to) navigate(item.to)
    else if (item.hero) navigate(newTaskPrefillHref({ ref: item.hero.task }))
  }
  return (
    <OnboardingDialog
      wide
      title="What’s new"
      description={description}
      onOpenChange={onOpenChange}
      onSubmit={next}
      footer={
        <div className="flex w-full items-center gap-2">
          <span className="mr-auto flex items-center gap-1.5" aria-label={`${index + 1} of ${items.length}`}>
            {items.map((entry, at) => (
              <span key={entry.id} aria-hidden="true" className={cn('h-1.5 rounded-full transition-all', at === index ? 'w-4 bg-violet' : 'w-1.5 bg-border')} />
            ))}
          </span>
          {index > 0 ? (
            <Button variant="outline" className="font-normal" onClick={() => setIndex(index - 1)}>
              Back
            </Button>
          ) : null}
          <Button className="font-normal" onClick={next}>
            {last ? 'Done' : 'Next'}
          </Button>
        </div>
      }
    >
      <div
        data-slot="whats-new-item"
        data-feature={item.preview}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && !last) setIndex(index + 1)
          if (event.key === 'ArrowLeft' && index > 0) setIndex(index - 1)
        }}
      >
        <FeaturePreview id={item.preview} />
        <div className="mt-5 flex min-h-32 flex-col">
          <div className="flex items-center gap-2 text-[12px]">
            <span className="rounded-full bg-violet/15 px-2 py-0.5 text-violet">New</span>
            <span className="text-soft-foreground">{new Date(item.releasedAt).toLocaleDateString('en', { month: 'short', day: 'numeric' })}</span>
          </div>
          <h3 className="mt-2 text-lg font-light tracking-tight text-foreground">{item.title}</h3>
          <p className="mt-1 text-[13px] text-muted-foreground">{item.description}</p>
          {actionLabel ? (
            <button type="button" onClick={go} className="mt-3 inline-flex items-center gap-1 text-[13px] text-violet hover:underline">
              {actionLabel}
              <ArrowRightIcon className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </OnboardingDialog>
  )
}

/** A miniature of the feature, drawn with the cockpit's own surfaces. */
function FeaturePreview({ id }: { id: FeaturePreviewId }) {
  return (
    <div aria-hidden="true" className="onboarding-preview flex h-44 items-end justify-center overflow-hidden rounded-lg border border-border px-8 pt-6">
      {id === 'tabs' ? <TabsPreview /> : null}
      {id === 'palette' ? <PalettePreview /> : null}
      {id === 'design' ? <DesignPreview /> : null}
      {id === 'scripts' ? <ScriptsPreview /> : null}
      {id === 'workflow' ? <WorkflowPreview /> : null}
      {id === 'automations' ? <AutomationsPreview /> : null}
    </div>
  )
}

function PreviewWindow({ bar, children }: { bar?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="w-full max-w-xs rounded-t-lg border border-b-0 border-border bg-background shadow-[0_-12px_40px_-20px_var(--violet)]">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        {bar}
      </div>
      <div className="p-3">{children}</div>
    </div>
  )
}

const previewLine = 'h-2 rounded bg-muted'

function TabsPreview() {
  return (
    <PreviewWindow
      bar={
        <span className="ml-3 flex gap-3 text-[10px]">
          {['Chat', 'Changes', 'Preview', 'Terminal'].map((tab) => (
            <span key={tab} className={tab === 'Preview' ? 'text-foreground underline decoration-violet decoration-2 underline-offset-[9px]' : 'text-soft-foreground'}>
              {tab}
            </span>
          ))}
        </span>
      }
    >
      <div className={cn(previewLine, 'w-3/4')} />
      <div className={cn(previewLine, 'mt-2 w-1/2')} />
      <div className="mt-3 h-12 rounded-md border border-border bg-card" />
    </PreviewWindow>
  )
}

function PalettePreview() {
  return (
    <div className="w-full max-w-xs self-center rounded-lg border border-border bg-background p-2 shadow-[0_18px_40px_-20px_var(--violet)]">
      <div className="flex items-center gap-2 border-b border-border px-1 pb-2 text-[11px] text-soft-foreground">
        <span className="rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">⌘P</span>
        Jump to a task or run an action
      </div>
      {['Fix the login redirect', 'Open Changes', 'Terminal in a column'].map((row, at) => (
        <div key={row} className={cn('mt-1 rounded px-2 py-1.5 text-[11px]', at === 0 ? 'bg-violet/15 text-foreground' : 'text-muted-foreground')}>
          {row}
        </div>
      ))}
    </div>
  )
}

function DesignPreview() {
  return (
    <PreviewWindow>
      <div className={cn(previewLine, 'w-2/3')} />
      <div className="relative mt-4 flex items-center gap-2">
        <span className="relative h-6 w-16 rounded-md border border-violet bg-violet/15">
          <span className="absolute -top-1 -left-1 size-1.5 rounded-[2px] bg-violet" />
          <span className="absolute -top-1 -right-1 size-1.5 rounded-[2px] bg-violet" />
          <span className="absolute -bottom-1 -left-1 size-1.5 rounded-[2px] bg-violet" />
          <span className="absolute -right-1 -bottom-1 size-1.5 rounded-[2px] bg-violet" />
        </span>
        <span className="h-6 w-10 rounded-md bg-muted" />
        <span className="absolute top-7 left-6 rounded-md rounded-tl-sm border border-border bg-card px-2 py-1 text-[10px] whitespace-nowrap text-foreground shadow-md">
          Make this button larger
        </span>
      </div>
      <div className={cn(previewLine, 'mt-10 w-3/4')} />
    </PreviewWindow>
  )
}

function ScriptsPreview() {
  return (
    <PreviewWindow bar={<span className="ml-3 text-[10px] text-soft-foreground">After worktree creation</span>}>
      {['npm install', 'cp .env.example .env'].map((command) => (
        <div key={command} className="flex items-center gap-2 py-1 font-mono text-[11px]">
          <span className="text-soft-foreground">$</span>
          <span className="flex-1 text-foreground">{command}</span>
          <span className="text-success">done</span>
        </div>
      ))}
      <div className="mt-2 flex items-center gap-2 font-mono text-[11px] text-soft-foreground">
        <span>$</span>
        <span className="h-3 w-1.5 bg-violet" />
      </div>
    </PreviewWindow>
  )
}

function WorkflowPreview() {
  return (
    <div className="flex w-full max-w-64 items-center self-center">
      {['Plan', 'Build', 'Review'].map((step, at) => (
        <React.Fragment key={step}>
          {at > 0 ? <span className="h-px flex-1 bg-muted-foreground/40" /> : null}
          <span
            className={cn(
              'rounded-md border bg-background px-3 py-2 text-[11px]',
              at === 1 ? 'border-violet text-foreground shadow-[0_10px_30px_-14px_var(--violet)]' : 'border-border text-muted-foreground',
            )}
          >
            {step}
          </span>
        </React.Fragment>
      ))}
    </div>
  )
}

function AutomationsPreview() {
  return (
    <PreviewWindow>
      {['Every weekday at 9:00', 'When a pull request is merged'].map((trigger) => (
        <div key={trigger} className="flex items-center gap-3 py-1.5 text-[11px] text-foreground">
          <span className="flex-1">{trigger}</span>
          <span className="flex h-3.5 w-6 items-center justify-end rounded-full bg-violet px-0.5">
            <span className="size-2.5 rounded-full bg-violet-foreground" />
          </span>
        </div>
      ))}
    </PreviewWindow>
  )
}
