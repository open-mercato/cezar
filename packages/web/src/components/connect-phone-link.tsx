import type { PhonesResponse } from '@open-mercato/cezar-api-client'
import { SmartphoneIcon } from 'lucide-react'
import { Link } from 'react-router'

import { usePhones } from '@/api/phones'
import { useHealth } from '@/api/queries'
import { relayIndicator } from '@/components/relay-status'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'

/** Settings > Connect a phone: the email, terms and QR flow (spec 2026-11-01-relay-qr-pairing). */
export const CONNECT_PHONE_HREF = '/settings/global/phones'

/** cezar's own phone list, or undefined while unknown or with pairing off. Live through `phone-pairing`. */
function usePhoneList(): PhonesResponse | undefined {
  const health = useHealth()
  const enabled = health.data?.capabilities.phonePairing === true
  const phones = usePhones(enabled)
  return enabled ? phones.data : undefined
}

/** The relay's state as a dot on the phone entry; the entry's tooltip says it in words. */
function RelayDot({ data, className = 'top-0.5 right-0.5' }: { data: PhonesResponse | undefined; className?: string }) {
  const indicator = relayIndicator(data)
  if (!indicator) return null
  return (
    <StatusDot
      tone={indicator.tone}
      pulse={indicator.pulse}
      data-slot="relay-dot"
      data-blocked={indicator.blocked || undefined}
      className={`absolute ring-2 ring-sidebar ${className}`}
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
        <RelayDot data={data} className="-top-0.5 -right-0.5" />
      </span>
      Connect your phone
    </Link>
  )
}

/**
 * Once a phone is paired: a quiet icon in the controls row, left of the settings gear. It carries the
 * row's `ml-auto`, so the gear drops its own when this is there (#702: every control stays a sibling).
 */
export function PhonesLink({ onNavigate }: { onNavigate?: () => void }) {
  const data = usePhoneList()
  if (!data || data.phones.length === 0) return null
  const indicator = relayIndicator(data)
  return (
    <Button asChild variant="ghost" size="icon" className="relative ml-auto hidden size-7 shrink-0 md:inline-flex">
      <Link
        to={CONNECT_PHONE_HREF}
        data-slot="phones-link"
        aria-label={indicator ? `Phones: ${indicator.text}` : 'Phones'}
        title={indicator ? `Phones · ${indicator.text}` : 'Phones'}
        onClick={onNavigate}
      >
        <SmartphoneIcon className="size-4" aria-hidden="true" />
        <RelayDot data={data} />
      </Link>
    </Button>
  )
}
