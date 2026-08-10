import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export type CenteredStateTone = 'neutral' | 'primary' | 'danger'

/** The tile carries a border + a solid-enough fill so it reads on the twinkle backdrop
 *  (a muted fill with a muted icon all but disappears there) — mercato's exact grammar. */
const tileTone: Record<CenteredStateTone, string> = {
  primary: 'border-primary/25 bg-primary/15 text-primary',
  neutral: 'border-border bg-card text-foreground shadow-xs',
  danger: 'border-danger/20 bg-danger/15 text-danger',
}

/**
 * The one template for every loading/paused/error/empty state (spec, "Design system"):
 * a 72px tinted icon tile, a `text-2xl` title, a muted subtitle, an actions row. Views never
 * hand-roll a centered message — they say which tone this moment is and what to do next.
 *
 * `backdrop` opts into the twinkle scatter. It is for hero/empty/lifecycle surfaces ONLY —
 * a data-dense view stays flat, so the default is off and stays off.
 */
export function CenteredState({
  icon,
  tone = 'neutral',
  title,
  subtitle,
  children,
  actions,
  backdrop = false,
  heading: Heading = 'h1',
  className,
}: {
  icon: ReactNode
  tone?: CenteredStateTone
  title: string
  subtitle?: string
  /** Free-form content below the subtitle (the `/new` param echo uses this). */
  children?: ReactNode
  actions?: ReactNode
  backdrop?: boolean
  /** `h1` when the state IS the page; `h2` when it sits under an existing page heading. */
  heading?: 'h1' | 'h2'
  className?: string
}) {
  return (
    <div
      data-slot="centered-state"
      data-tone={tone}
      className={cn(
        'relative isolate flex min-h-full flex-1 flex-col items-center justify-center px-6 py-12 text-center',
        className
      )}
    >
      {backdrop ? <TwinkleBackdrop /> : null}
      <div className="flex w-full max-w-md flex-col items-center gap-4">
        <div
          data-slot="centered-state-tile"
          className={cn(
            "flex size-[72px] items-center justify-center rounded-[18px] border [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-7",
            tileTone[tone]
          )}
        >
          {icon}
        </div>
        <Heading className="text-2xl font-semibold text-balance text-foreground">{title}</Heading>
        {subtitle ? <p className="text-sm text-pretty text-muted-foreground">{subtitle}</p> : null}
        {children ? <div className="w-full pt-2">{children}</div> : null}
        {actions ? <div className="flex items-center justify-center gap-3 pt-2">{actions}</div> : null}
      </div>
    </div>
  )
}

/** One decorative square. Sizes are 2/3px; tones are the brand trio, violet-weighted. */
type Twinkle = {
  top: string
  left: string
  size: 2 | 3
  tone: 'violet' | 'primary' | 'pending'
  opacity: number
}

/** The mockups' static scatter (new-task.html `.twinkles`), not a canvas: at 2–3px a dozen
 *  positioned squares are indistinguishable from a particle field and cost nothing. Densest at
 *  the top, thinning down — the mask finishes the fade so nothing collides with the content. */
const TWINKLES: Twinkle[] = [
  { top: '6%', left: '14%', size: 2, tone: 'violet', opacity: 0.5 },
  { top: '11%', left: '31%', size: 3, tone: 'violet', opacity: 0.45 },
  { top: '8%', left: '52%', size: 2, tone: 'pending', opacity: 0.4 },
  { top: '15%', left: '71%', size: 2, tone: 'violet', opacity: 0.5 },
  { top: '9%', left: '86%', size: 3, tone: 'primary', opacity: 0.4 },
  { top: '22%', left: '8%', size: 2, tone: 'pending', opacity: 0.4 },
  { top: '27%', left: '24%', size: 2, tone: 'primary', opacity: 0.35 },
  { top: '20%', left: '44%', size: 3, tone: 'violet', opacity: 0.35 },
  { top: '25%', left: '62%', size: 2, tone: 'violet', opacity: 0.4 },
  { top: '30%', left: '79%', size: 2, tone: 'primary', opacity: 0.35 },
  { top: '36%', left: '12%', size: 3, tone: 'violet', opacity: 0.3 },
  { top: '42%', left: '35%', size: 2, tone: 'pending', opacity: 0.28 },
  { top: '47%', left: '58%', size: 2, tone: 'primary', opacity: 0.28 },
  { top: '52%', left: '88%', size: 2, tone: 'violet', opacity: 0.25 },
  { top: '60%', left: '29%', size: 3, tone: 'violet', opacity: 0.22 },
]

const twinkleTone: Record<Twinkle['tone'], string> = {
  violet: 'bg-violet',
  primary: 'bg-primary',
  pending: 'bg-pending',
}

/**
 * The sparse brand-square scatter for hero/empty/lifecycle surfaces (spec, "Design system":
 * textures live ONLY there — never on data-dense screens).
 *
 * Purely decorative, so `aria-hidden` and pointer-transparent. The gentle staggered pulse is
 * `motion-safe:` — under `prefers-reduced-motion` the squares render static at their base
 * opacity, exactly as the spec's motion rules require.
 */
export function TwinkleBackdrop({ className }: { className?: string }) {
  return (
    <div
      data-slot="twinkle-backdrop"
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-0 -z-10 overflow-hidden [mask-image:linear-gradient(to_bottom,black_25%,transparent_88%)]',
        className
      )}
    >
      {TWINKLES.map((tw, index) => (
        <span
          key={index}
          className={cn(
            'absolute rounded-[1px] motion-safe:animate-pulse',
            tw.size === 3 ? 'size-[3px]' : 'size-0.5',
            twinkleTone[tw.tone]
          )}
          style={{
            top: tw.top,
            left: tw.left,
            opacity: tw.opacity,
            animationDuration: '3.5s',
            animationDelay: `${(index % 5) * 700}ms`,
          }}
        />
      ))}
    </div>
  )
}
