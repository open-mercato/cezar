import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { CheckIcon, ShieldCheckIcon, XIcon } from 'lucide-react'

import { putTelemetryConsent } from '@/api/client'
import { useTelemetryConsent, workspaceQueryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/components/ui/toaster'
import { resetSid } from '@/lib/sid'
import { TELEMETRY_CODE_URL, TELEMETRY_DOC_URL, shouldAskForTelemetry } from '@/lib/telemetry-consent'

/**
 * The opt-in ask (docs/telemetry.md). A bar at the bottom of the main column while this machine
 * has never answered — it covers nothing and interrupts nothing, and the only modal is the
 * "Details" sheet the person asks for. Both answers are one click, on the same layer; nothing is
 * sent before a "Share" click.
 */

const SHARED = [
  'How many tasks you start (agent, model)',
  'How many messages you send',
  'Which pages you open',
  'Errors, with your paths removed',
  'Version, OS, app or CLI',
  'A random install id',
]
const NEVER = [
  'Prompts, messages, code, diffs',
  'File paths',
  'Repo, branch or project names',
  'Keys or credentials',
  'Your IP, in any payload',
]

/** Record an answer and put the server's reply in the cache every reader shares. */
export function useSetTelemetryConsent() {
  const queryClient = useQueryClient()
  return useCallback(
    async (consent: 'granted' | 'denied') => {
      try {
        const next = await putTelemetryConsent({ consent })
        queryClient.setQueryData(workspaceQueryKeys.telemetryConsent, next)
        if (consent === 'denied') resetSid()
        return true
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        return false
      }
    },
    [queryClient],
  )
}

type Answer = 'granted' | 'denied'

function AnswerButtons({ busy, onAnswer, size }: { busy: boolean; onAnswer: (c: Answer) => void; size: 'sm' | 'lg' }) {
  const cls = size === 'lg' ? 'min-h-11' : 'h-9'
  return (
    <>
      <Button variant="outline" className={cls} disabled={busy} data-slot="telemetry-deny" onClick={() => onAnswer('denied')}>
        Don’t share
      </Button>
      <Button className={cls} disabled={busy} data-slot="telemetry-grant" onClick={() => onAnswer('granted')}>
        Share usage data
      </Button>
    </>
  )
}

export function TelemetryConsentBanner() {
  const consent = useTelemetryConsent()
  const setConsent = useSetTelemetryConsent()
  const [busy, setBusy] = useState(false)
  const [details, setDetails] = useState(false)
  if (!shouldAskForTelemetry(consent.data)) return null

  const answer = async (c: Answer) => {
    setBusy(true)
    const ok = await setConsent(c)
    setBusy(false)
    if (ok) setDetails(false)
  }

  return (
    <div data-slot="telemetry-consent-banner" className="px-4 pb-3 md:px-5 md:pb-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border bg-card px-4 py-3 shadow-lg">
        <ShieldCheckIcon className="hidden size-[18px] shrink-0 text-violet sm:block" aria-hidden="true" />
        <p className="min-w-0 flex-1 basis-[280px] text-[13px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Help improve cezar?</span> With your OK we send task
          counts and crash reports to the maintainers — never prompts, code, paths or repo names. Change it
          anytime in Settings → Privacy.{' '}
          <button
            type="button"
            data-slot="telemetry-details"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => setDetails(true)}
          >
            Details
          </button>
        </p>
        <div className="flex gap-2">
          <AnswerButtons busy={busy} onAnswer={(c) => void answer(c)} size="sm" />
        </div>
      </div>
      <TelemetryDetailsDialog open={details} onOpenChange={setDetails} busy={busy} onAnswer={(c) => void answer(c)} />
    </div>
  )
}

function ConsentList({ title, tone, items }: { title: string; tone: 'ok' | 'no'; items: string[] }) {
  const Icon = tone === 'ok' ? CheckIcon : XIcon
  return (
    <div>
      <span className="block text-[13px] font-medium text-foreground">{title}</span>
      <ul className="mt-2 space-y-1.5">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-[13px] leading-snug text-muted-foreground">
            <Icon
              className={`mt-0.5 size-3.5 shrink-0 ${tone === 'ok' ? 'text-success' : 'text-soft-foreground'}`}
              aria-hidden="true"
            />
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The second layer, opened only from the bar's "Details": everything that is and isn't sent. */
export function TelemetryDetailsDialog({
  open,
  onOpenChange,
  busy,
  onAnswer,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  busy: boolean
  onAnswer: (c: Answer) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="telemetry-details-dialog"
        className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-[480px]"
        // No button starts focused: a ring on either answer reads as the suggested one.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement).focus()
        }}
      >
        <div className="space-y-5 p-6">
          <div className="space-y-1.5">
            <span className="block font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              What is sent
            </span>
            <DialogTitle className="text-xl font-semibold tracking-tight">Usage data, in full</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
              Counts of what you use and reports of what broke, so cezar’s maintainers at Open Mercato
              can fix bugs without you filing them. Off until you say yes.
            </DialogDescription>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <ConsentList title="Shared" tone="ok" items={SHARED} />
            <ConsentList title="Never shared" tone="no" items={NEVER} />
          </div>

          <p className="text-xs leading-relaxed text-soft-foreground">
            Every label is a closed list the server enforces. Withdraw anytime in Settings → Privacy or
            with <code className="font-mono">cezar telemetry disable</code> — the install id is deleted.{' '}
            <a href={TELEMETRY_CODE_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
              Read the code
            </a>
            {' · '}
            <a href={TELEMETRY_DOC_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
              Privacy notice
            </a>
          </p>

          <div className="grid grid-cols-2 gap-2">
            <AnswerButtons busy={busy} onAnswer={onAnswer} size="lg" />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
