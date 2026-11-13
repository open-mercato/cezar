import { useQuery } from '@tanstack/react-query'
import { SmartphoneIcon } from 'lucide-react'
import { Link } from 'react-router'

import { getPhones, phoneKeys } from '@/api/phones'
import { useHealth } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'

/** Settings > Connect a phone: the email, terms and QR flow (spec 2026-11-01-relay-qr-pairing). */
export const CONNECT_PHONE_HREF = '/settings/global/phones'

/**
 * The sidebar footer's way to the phone, icon-only beside the version chip so the row stays one
 * line. Gone on phone-sized screens and once a phone is paired, where Settings lists the phones.
 * Reads only cezar's own phone list, so showing it contacts no relay.
 */
export function ConnectPhoneLink({ onNavigate }: { onNavigate?: () => void }) {
  const health = useHealth()
  const enabled = health.data?.capabilities.phonePairing === true
  const phones = useQuery({ queryKey: phoneKeys.list, queryFn: ({ signal }) => getPhones({ signal }), enabled })
  if (!enabled || !phones.data || phones.data.phones.length > 0) return null
  return (
    <IconTooltip label="Connect your phone" side="top">
      <Button asChild variant="ghost" size="icon" className="hidden size-6 md:inline-flex">
        <Link to={CONNECT_PHONE_HREF} data-slot="connect-phone-link" aria-label="Connect your phone" onClick={onNavigate}>
          <SmartphoneIcon className="size-3.5" aria-hidden="true" />
        </Link>
      </Button>
    </IconTooltip>
  )
}
