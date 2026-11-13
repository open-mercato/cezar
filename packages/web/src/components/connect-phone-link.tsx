import { useQuery } from '@tanstack/react-query'
import { SmartphoneIcon } from 'lucide-react'
import { Link } from 'react-router'

import { getPhones, phoneKeys } from '@/api/phones'
import { useHealth } from '@/api/queries'
import { Button } from '@/components/ui/button'

/** Settings > Connect a phone: the email, terms and QR flow (spec 2026-11-01-relay-qr-pairing). */
export const CONNECT_PHONE_HREF = '/settings/global/phones'

/** How many phones are paired, or null while unknown or with pairing off. Reads only cezar's own list. */
function usePairedCount(): number | null {
  const health = useHealth()
  const enabled = health.data?.capabilities.phonePairing === true
  const phones = useQuery({ queryKey: phoneKeys.list, queryFn: ({ signal }) => getPhones({ signal }), enabled })
  return enabled && phones.data ? phones.data.phones.length : null
}

/**
 * The sidebar footer's way to the phone before one is paired: a labelled row, like What's new.
 * Gone on phone-sized screens and once a phone is paired, when {@link PhonesLink} takes over.
 */
export function ConnectPhoneLink({ onNavigate }: { onNavigate?: () => void }) {
  if (usePairedCount() !== 0) return null
  return (
    <Link
      to={CONNECT_PHONE_HREF}
      data-slot="connect-phone-link"
      title="Get the Cezar app on your phone and pair it with this computer"
      onClick={onNavigate}
      className="hidden h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-ui text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:flex"
    >
      <SmartphoneIcon className="size-4 shrink-0" aria-hidden="true" />
      Connect your phone
    </Link>
  )
}

/**
 * Once a phone is paired: a quiet icon in the controls row, left of the settings gear. It carries the
 * row's `ml-auto`, so the gear drops its own when this is there (#702: every control stays a sibling).
 */
export function PhonesLink({ onNavigate }: { onNavigate?: () => void }) {
  const paired = usePairedCount()
  if (paired === null || paired === 0) return null
  return (
    <Button asChild variant="ghost" size="icon" className="ml-auto hidden size-7 shrink-0 md:inline-flex">
      <Link to={CONNECT_PHONE_HREF} data-slot="phones-link" aria-label="Phones" title="Phones" onClick={onNavigate}>
        <SmartphoneIcon className="size-4" aria-hidden="true" />
      </Link>
    </Button>
  )
}
