import { ChevronDownIcon, LaptopIcon } from 'lucide-react'
import { deviceColor, deviceInitials } from '@/lib/device-identity'
import { cn } from '@/lib/utils'

// CezarBot's account switcher (switcher spec, parent task 2fb255e3): the page draws only its own
// computer and opens the native list by navigating to `cezar://servers`, which the shell handles.
const SERVERS_URL = 'cezar://servers'

const switchLabel = (name?: string) => (name ? `Switch computer: ${name}` : 'Switch computer')

/** The round avatar: white initials on the name's automatic colour, a laptop glyph without them. */
export function DeviceAvatar({ name, size }: { name?: string; size: number }) {
  const initials = name ? deviceInitials(name) : ''
  return (
    <span
      data-slot="device-avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4), ...(name ? { background: deviceColor(name) } : {}) }}
      className={cn(
        'grid shrink-0 place-items-center rounded-full font-bold tracking-[.02em] text-device-ink',
        !name && 'bg-muted text-muted-foreground',
      )}
    >
      {initials || <LaptopIcon style={{ width: size * 0.5, height: size * 0.5 }} />}
    </span>
  )
}

/** The header's avatar button (phone top bar, folded rail). */
export function DeviceAvatarLink({ name, size, slot, className }: { name?: string; size: number; slot: string; className?: string }) {
  return (
    <a
      href={SERVERS_URL}
      data-slot={slot}
      aria-label={switchLabel(name)}
      title={name}
      className={cn('flex shrink-0 items-center justify-center rounded-full outline-none hover:ring-[3px] hover:ring-border focus-visible:ring-[3px] focus-visible:ring-ring/50', className)}
    >
      <DeviceAvatar name={name} size={size} />
    </a>
  )
}

/** The wide sidebar's top: avatar, the computer's name and a chevron, in place of the brand. */
export function DeviceChip({ name, onNavigate }: { name?: string; onNavigate?: () => void }) {
  return (
    <a
      href={SERVERS_URL}
      data-slot="device-chip"
      aria-label={switchLabel(name)}
      onClick={onNavigate}
      className="-ml-1.5 flex min-h-12 min-w-0 items-center gap-2 rounded-[11px] py-1.5 pr-2 pl-1.5 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <DeviceAvatar name={name} size={30} />
      <span data-slot="device-name" className="min-w-0 truncate text-body font-semibold">{name ?? 'Devices'}</span>
      <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </a>
  )
}
