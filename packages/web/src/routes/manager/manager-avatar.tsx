import { cn } from '@/lib/utils'

/** 8 shapes × 8 hues = the 64 values `managerSchema.avatar` allows. */
const SHAPES = [
  'M16 3a13 13 0 1 0 0 26 13 13 0 0 0 0-26Z',
  'M16 2c5 6 11 11 11 17a11 11 0 0 1-22 0C5 13 11 8 16 2Z',
  'M9 25a7 7 0 0 1-1-14 8.5 8.5 0 0 1 16 0 7 7 0 0 1-1 14Z',
  'M10 4h12a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6V10a6 6 0 0 1 6-6Z',
  'M16 4c1.5 0 2.7.8 3.5 2.2l8.6 15.6c1.3 2.5-.4 5.2-3.2 5.2H7.1c-2.8 0-4.5-2.7-3.2-5.2l8.6-15.6C13.3 4.8 14.5 4 16 4Z',
  'M9 8h14a8 8 0 0 1 8 8v0a8 8 0 0 1-8 8H9a8 8 0 0 1-8-8v0a8 8 0 0 1 8-8Z',
  'M17 3c6 0 12 4 12 12 0 9-6 14-13 14S3 25 3 17 9 3 17 3Z',
  'M6 4h13a4 4 0 0 1 3 1l5 6a4 4 0 0 1 1 3v10a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4Z',
] as const
const HUES = [285, 245, 150, 190, 55, 25, 340, 275] as const

/** Bijective: each shape walks every hue as the index climbs, so the first eight differ twice over. */
export function avatarParts(index: number): { shape: string; hue: number } {
  const i = Math.abs(Math.trunc(index)) % 64
  return { shape: SHAPES[i % 8]!, hue: HUES[(i + (i >> 3)) % 8]! }
}

/** The blob with two eyes from the Figma sidebar. Decorative: the name always sits beside it. */
export function ManagerAvatar({ avatar, className }: { avatar: number; className?: string }) {
  const { shape, hue } = avatarParts(avatar)
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      data-slot="manager-avatar"
      className={cn('size-9 shrink-0', className)}
      style={{ color: `oklch(0.66 0.16 ${hue})` }}
    >
      <path d={shape} fill="currentColor" />
      <ellipse cx="12.5" cy="13" rx="1.1" ry="1.7" fill="white" opacity="0.9" />
      <ellipse cx="19.5" cy="13" rx="1.1" ry="1.7" fill="white" opacity="0.9" />
    </svg>
  )
}
