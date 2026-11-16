import type { PhonesResponse } from '@open-mercato/cezar-api-client'
import { SmartphoneIcon } from 'lucide-react'
import { Link } from 'react-router'

import { useCachedRelayAccount, usePhones } from '@/api/phones'
import { useHealth } from '@/api/queries'
import { CONNECT_PHONE_HREF, PhonesSummary } from '@/components/phones-summary'
import { phoneIconState, relayIndicator, type PhoneIconState } from '@/components/relay-status'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export { CONNECT_PHONE_HREF }

/** cezar's own phone list, or undefined while unknown or with pairing off. Live through `phone-pairing`. */
function usePhoneList(): PhonesResponse | undefined {
  const health = useHealth()
  const enabled = health.data?.capabilities.phonePairing === true
  const phones = usePhones(enabled)
  return enabled ? phones.data : undefined
}

/** Only when something needs the user: amber or red. All well is the green icon, never a dot. */
function RelayDot({ state, className = 'top-0.5 right-0.5' }: { state: PhoneIconState; className?: string }) {
  if (!state.dot) return null
  return (
    <StatusDot
      tone={state.dot}
      pulse={state.pulse}
      data-slot="relay-dot"
      data-blocked={state.blocked || undefined}
      className={`absolute ring-2 ring-sidebar ${className}`}
      aria-hidden="true"
    />
  )
}

/** The phone glyph, green when all is well (`data-look="ok"`). */
function PhoneGlyph({ state }: { state: PhoneIconState }) {
  return (
    <SmartphoneIcon
      data-slot="phones-icon"
      data-look={state.icon}
      className={cn('size-4', state.icon === 'ok' && 'text-success-strong')}
      aria-hidden="true"
    />
  )
}

/**
 * The sidebar footer's way to the phone before one is paired: a labelled row, like What's new.
 * Gone on phone-sized screens and once a phone is paired, when {@link PhonesLink} takes over.
 */
export function ConnectPhoneLink({ onNavigate }: { onNavigate?: () => void }) {
  const data = usePhoneList()
  if (data?.phones.length !== 0) return null
  // No phone, no socket: only a removal still owed to the relay can light the dot here.
  const indicator = relayIndicator(data)
  return (
    <Link
      to={CONNECT_PHONE_HREF}
      data-slot="connect-phone-link"
      title={indicator?.text ?? 'Get the CezarBot app on your phone and pair it with this computer'}
      onClick={onNavigate}
      className="hidden h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-ui text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:flex"
    >
      <span className="relative shrink-0">
        <SmartphoneIcon className="size-4" aria-hidden="true" />
        <RelayDot state={phoneIconState(data)} className="-top-0.5 -right-0.5" />
      </span>
      Connect your phone
    </Link>
  )
}

/**
 * Once a phone is paired: a quiet icon in the controls row, left of the version chip, opening a
 * summary popover with the way into Settings. `rail`: the folded sidebar's copy, above the expand
 * button. In the footer it carries the row's `ml-auto` (#702: every control stays a sibling).
 */
export function PhonesLink({ onNavigate, rail = false }: { onNavigate?: () => void; rail?: boolean }) {
  const data = usePhoneList()
  const account = useCachedRelayAccount()
  if (!data || data.phones.length === 0) return null
  const state = phoneIconState(data)
  const words = state.icon === 'ok' || state.dot ? state.text : state.summary
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-slot={rail ? 'rail-phones' : 'phones-link'}
          aria-label={`Phones: ${words}`}
          title={`Phones · ${words}`}
          className={cn(
            'relative shrink-0',
            rail ? 'size-8 text-muted-foreground hover:bg-muted hover:text-foreground' : 'ml-auto hidden size-7 md:inline-flex',
          )}
        >
          <PhoneGlyph state={state} />
          <RelayDot state={state} className={rail ? 'top-1 right-1' : undefined} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={rail ? 'right' : 'top'}
        align="end"
        data-slot="phones-summary"
        className="w-72 max-w-[calc(100vw-2rem)]"
      >
        <PhonesSummary data={data} state={state} account={account} onNavigate={onNavigate} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
