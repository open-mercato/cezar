import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SmartphoneIcon, XIcon } from 'lucide-react'
import { Link } from 'react-router'

import { dismissRelayAccountPrompt, getPhones, phoneKeys, useRelayAccount } from '@/api/phones'
import { useHealth } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { timeLeft } from '@/routes/settings/relay-account'

/** Settings > Connect a phone's email step, opened for an existing pairing rather than a new code. */
export const ADD_EMAIL_HREF = '/settings/global/phones?email=1'

/**
 * Phones paired before relay accounts (RELAY_PROTOCOL.md § 18): a small bar with the grace left,
 * linking to the pairing flow's email step. Never a modal; dismissing it hides it for good, and
 * Settings keeps saying so. The relay's grace keeps the phones working meanwhile.
 */
export function RelayAccountNotice() {
  const health = useHealth()
  const enabled = health.data?.capabilities.phonePairing === true
  const phones = useQuery({ queryKey: phoneKeys.list, queryFn: ({ signal }) => getPhones({ signal }), enabled })
  return enabled && phones.data?.account.prompt === true ? <NoticeBar /> : null
}

function NoticeBar() {
  const queryClient = useQueryClient()
  const account = useRelayAccount()
  const dismiss = useMutation({
    mutationFn: dismissRelayAccountPrompt,
    onSettled: () => queryClient.invalidateQueries({ queryKey: phoneKeys.list }),
  })
  const left = account.data?.status?.secondsLeft ?? null
  return (
    <div
      role="status"
      data-testid="relay-account-notice"
      className="flex min-h-9 items-center gap-2 border-b border-border bg-warning/10 px-4 text-sm text-foreground"
    >
      <SmartphoneIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-1">
        Your paired phones need an email on file{left !== null ? `. They keep working for ${timeLeft(left)}` : ''}.{' '}
        <Link to={ADD_EMAIL_HREF} className="underline underline-offset-2">Add email</Link>
      </span>
      <Button variant="ghost" size="icon" aria-label="Dismiss" disabled={dismiss.isPending} onClick={() => dismiss.mutate()}>
        <XIcon className="size-4" aria-hidden />
      </Button>
    </div>
  )
}
