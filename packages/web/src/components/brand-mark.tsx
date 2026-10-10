import { cn } from '@/lib/utils'

/**
 * The cezar mark and its lockup with the name — the brand guideline's "Znak z nazwą".
 *
 * THE MARK is the white geometric C of `public/icon.svg` WITHOUT its black tile: beside the
 * name it stands on the surface it is placed on, in the text colour (`currentColor`), so it is
 * white on the dark sidebar and near-black on the light one. The tile belongs to the places
 * that need a self-contained picture — the favicon and the app icon — and those keep using
 * `/icon.svg`. The shapes here are that file's polygons, byte for byte;
 * `brand-asset.test.ts` fails if the two ever drift.
 *
 * THE LOCKUP follows the guideline's arithmetic, stated once in `BRAND_LOCKUP`:
 *   - the name is always lowercase, Chakra Petch SemiBold (600), tracking untouched;
 *   - the mark is 1.5 × the type size tall (the guideline rounds the navigation pair to
 *     26px over 19px);
 *   - the gap between them is 0.6 × the type size.
 */

/** The mark's polygons, in `icon.svg`'s 704-unit space. */
export const BRAND_MARK_POLYGONS = [
  '354.6,217.3 511.0,307.6 421.0,359.6 354.6,321.2 267.9,371.2 267.9,471.3 444.6,573.3 354.6,625.3 177.9,523.3 177.9,319.3',
  '177.9,284.6 354.6,182.6 354.6,78.7 177.9,180.7',
  '354.6,372.3 397.0,396.8 397.0,445.8 354.6,470.3 312.1,445.8 312.1,396.8',
  '483.7,372.3 526.1,396.8 526.1,445.8 483.7,470.3 441.2,445.8 441.2,396.8',
] as const

/** The polygons' bounding box — the viewBox of the mark once the tile is gone. */
const MARK_BOX = { x: 177.9, y: 78.7, width: 348.2, height: 546.6 } as const

/** The navigation lockup, in px: the guideline's "znak 26 px i nazwa 19 px", gap 0.6 × 19. */
export const BRAND_LOCKUP = { mark: 26, name: 19, gap: 11.4 } as const

export function BrandMark({ height = BRAND_LOCKUP.mark, className }: { height?: number; className?: string }) {
  return (
    <svg
      data-slot="brand-mark"
      aria-hidden="true"
      focusable="false"
      viewBox={`${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.width} ${MARK_BOX.height}`}
      height={height}
      width={(height * MARK_BOX.width) / MARK_BOX.height}
      fill="currentColor"
      className={cn('shrink-0', className)}
    >
      {BRAND_MARK_POLYGONS.map((points) => (
        <polygon key={points} points={points} />
      ))}
    </svg>
  )
}

/** The mark beside the name, at the navigation sizes. */
export function BrandLockup({ className, name = 'cezar', logoUrl = null }: { className?: string; name?: string; logoUrl?: string | null }) {
  return (
    <span
      data-slot="brand-lockup"
      className={cn('flex min-w-0 items-center text-foreground', className)}
      style={{ gap: BRAND_LOCKUP.gap }}
    >
      {logoUrl ? <img data-slot="brand-logo" src={logoUrl} alt="" className="size-[26px] shrink-0 object-contain" /> : <BrandMark />}
      <span
        data-slot="brand-name"
        className={cn('max-w-full truncate leading-none font-semibold tracking-normal', name === 'cezar' && 'lowercase')}
        style={{ fontFamily: 'var(--brand)', fontSize: BRAND_LOCKUP.name }}
      >
        {name}
      </span>
    </span>
  )
}

/** Runtime brand settings are workspace-global and cached by the shared config query. */
