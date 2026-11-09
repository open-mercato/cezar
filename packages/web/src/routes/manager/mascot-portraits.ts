/** Portraits only, so the sidebar's avatars do not pull every rig part's URL into the boot chunk. */
const portraits = import.meta.glob<string>('../../assets/mascots/*/portrait*.webp', { eager: true, query: '?url', import: 'default' })

/** Pixel widths of the portrait variants `build-mascot-assets.mjs` emits; 256 is the original. */
export const PORTRAIT_WIDTHS = [96, 192, 256] as const

export function mascotPortrait(mascot: string): { src: string; srcSet: string } {
  const url = (width: number) => portraits[`../../assets/mascots/${mascot}/${width === 256 ? 'portrait' : `portrait-${width}`}.webp`]
  const urls = PORTRAIT_WIDTHS.map((width) => [url(width), width] as const)
  if (urls.some(([value]) => !value)) throw new Error(`Missing mascot portrait: ${mascot}`)
  return { src: urls[0]![0]!, srcSet: urls.map(([value, width]) => `${value} ${width}w`).join(', ') }
}
