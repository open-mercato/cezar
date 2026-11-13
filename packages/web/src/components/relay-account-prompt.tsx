import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { dismissRelayAccountPrompt, getPhones, phoneKeys, useRelayAccount } from '@/api/phones'
import { useHealth } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { AccountForm, AccountWhy, timeLeft } from '@/routes/settings/relay-account'

/**
 * The one-time ask for phones paired before relay accounts (RELAY_PROTOCOL.md § 18). The server
 * says `prompt` only while phones exist, no account is held and the ask was never answered, so
 * this shows once per computer. Nothing breaks if it is put off: the relay's grace keeps them working.
 */
export function RelayAccountPrompt() {
  const health = useHealth()
  const enabled = health.data?.capabilities.phonePairing === true
  const phones = useQuery({ queryKey: phoneKeys.list, queryFn: ({ signal }) => getPhones({ signal }), enabled })
  const prompt = enabled && phones.data?.account.prompt === true
  return prompt ? <PromptDialog /> : null
}

function PromptDialog() {
  const queryClient = useQueryClient()
  const account = useRelayAccount()
  const dismiss = useMutation({
    mutationFn: dismissRelayAccountPrompt,
    onSettled: () => queryClient.invalidateQueries({ queryKey: phoneKeys.list }),
  })
  const left = account.data?.status?.secondsLeft ?? null
  return (
    <Dialog open onOpenChange={(open) => { if (!open) dismiss.mutate() }}>
      <DialogContent data-testid="relay-account-prompt">
        <DialogTitle>Your phones need an email on file</DialogTitle>
        <DialogDescription>
          The relay your phones connect through now asks for an email and accepted terms.
          {left !== null ? ` Your phones keep working for ${timeLeft(left)} without them.` : ' Your phones keep working for 48 hours without them.'}
        </DialogDescription>
        <AccountWhy />
        <AccountForm submitLabel="Save" onDone={() => void queryClient.invalidateQueries({ queryKey: phoneKeys.list })} />
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" disabled={dismiss.isPending} onClick={() => dismiss.mutate()}>Later, in Settings</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
