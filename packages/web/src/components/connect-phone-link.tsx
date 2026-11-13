import { useQuery } from '@tanstack/react-query'
import { SmartphoneIcon } from 'lucide-react'
import { Link } from 'react-router'

import { getPhones, phoneKeys } from '@/api/phones'
import { useHealth } from '@/api/queries'

/** Settings > Connect a phone: the email, terms and QR flow (spec 2026-11-01-relay-qr-pairing). */
export const CONNECT_PHONE_HREF = '/settings/global/phones'

/**
 * The sidebar footer's way to the phone: one labelled row, like What's new, because the controls row
 * has no width left. Gone on phone-sized screens and once a phone is paired, where Settings lists the
 * phones. Reads only cezar's own phone list, so showing it contacts no relay.
 */
export function ConnectPhoneLink({ onNavigate }: { onNavigate?: () => void }) {
  const health = useHealth()
  const enabled = health.data?.capabilities.phonePairing === true
  const phones = useQuery({ queryKey: phoneKeys.list, queryFn: ({ signal }) => getPhones({ signal }), enabled })
  if (!enabled || !phones.data || phones.data.phones.length > 0) return null
  return (
    <Link
      to={CONNECT_PHONE_HREF}
      data-slot="connect-phone-link"
      title="Pair the Cezar app with this computer"
      onClick={onNavigate}
      className="hidden h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-ui text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:flex"
    >
      <SmartphoneIcon className="size-4 shrink-0" aria-hidden="true" />
      Connect your phone
    </Link>
  )
}
