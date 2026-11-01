import { useId } from 'react'

import { cn } from '@/lib/utils'

/** The nine characters of the Figma sidebar, in its order. `eyes` is where each one looks from. */
const PERSONAS = [
  { shape: 'M16 3a13 13 0 1 0 0 26 13 13 0 0 0 0-26Z', eyes: [18, 11] },
  { shape: 'M16 2c5 6 11 11 11 17a11 11 0 0 1-22 0C5 13 11 8 16 2Z', eyes: [17.5, 14] },
  { shape: 'M8.5 26A6.5 6.5 0 0 1 6 13.5a7 7 0 0 1 8-5.2 7.500 7.500 0 0 1 12.7 3.2A7.500 7.500 0 0 1 24 26Z', eyes: [18, 12.5] },
  {
    shape: 'M8 3h12a5 5 0 0 1 5 5v11a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V8a5 5 0 0 1 5-5Z',
    eyes: [13, 9],
    companion: 'M22 12c3 3.600 7 6.400 7 10.500a7 7 0 0 1-14 0C15 18.400 19 15.600 22 12Z',
  },
  { shape: 'M16 3a13 13 0 1 0 0 26 13 13 0 0 0 0-26Z', eyes: [17, 9.5] },
  { shape: 'M16 3c6 0 10.500 8 10.500 15S22 29 16 29 5.500 25 5.500 18 10 3 16 3Z', eyes: [18, 10.5] },
  { shape: 'M10 7h12a9 9 0 0 1 0 18H10a9 9 0 0 1 0-18Z', eyes: [19, 12] },
  { shape: 'M16 4c1.500 0 2.700.8 3.500 2.200l8.600 15.600c1.300 2.500-.4 5.200-3.200 5.200H7.100c-2.800 0-4.500-2.700-3.200-5.200l8.600-15.600C13.300 4.800 14.500 4 16 4Z', eyes: [16, 13] },
  { shape: 'M9 3h14a6 6 0 0 1 6 6v14a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6V9a6 6 0 0 1 6-6Z', eyes: [18, 9.5] },
] as const

const COLORS = [
  'oklch(0.60 0.20 295)',
  'oklch(0.66 0.17 250)',
  'oklch(0.72 0.15 152)',
  'oklch(0.70 0.11 180)',
  'oklch(0.55 0.07 55)',
  'oklch(0.70 0.17 50)',
  'oklch(0.62 0.20 22)',
  'oklch(0.70 0.19 350)',
  'oklch(0.55 0.17 275)',
] as const

const COMPANION_COLOR = 'oklch(0.58 0.17 250)'

/** How many the persona picker offers: each character once, then once more in another colour. */
export const PERSONA_CHOICES = 18

/** Bijective over the 64 `managerSchema.avatar` values: past nine, a character changes colour. */
export function avatarParts(index: number) {
  const i = Math.abs(Math.trunc(index)) % 64
  const persona = PERSONAS[i % PERSONAS.length]!
  return { ...persona, fill: COLORS[(i + Math.floor(i / PERSONAS.length)) % COLORS.length]! }
}

function Eyes({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  const eye = (cx: number) => (
    <ellipse cx={cx} cy={y} rx={0.95 * scale} ry={1.9 * scale} fill="white" transform={`rotate(-10 ${cx} ${y})`} />
  )
  return <>{eye(x)}{eye(x + 4.2 * scale)}</>
}

/** A manager's persona. Decorative: the name always sits beside it. */
export function ManagerAvatar({ avatar, className }: { avatar: number; className?: string }) {
  const gloss = useId()
  const parts = avatarParts(avatar)
  const companion = 'companion' in parts ? parts.companion : undefined
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      data-slot="manager-avatar"
      data-persona={avatar}
      className={cn('size-11 shrink-0', className)}
    >
      <defs>
        <radialGradient id={gloss} cx="0.35" cy="0.2" r="0.9">
          <stop offset="0" stopColor="white" stopOpacity="0.32" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d={parts.shape} fill={parts.fill} />
      <path d={parts.shape} fill={`url(#${gloss})`} />
      <Eyes x={parts.eyes[0]} y={parts.eyes[1]} />
      {companion ? (
        <>
          <path d={companion} fill={COMPANION_COLOR} stroke="var(--background)" strokeWidth="1" />
          <path d={companion} fill={`url(#${gloss})`} />
          <Eyes x={21} y={21} scale={0.75} />
        </>
      ) : null}
    </svg>
  )
}
