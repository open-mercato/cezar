/** Vite owns fingerprinting and the server's existing /assets/:file route serves every part. Lazy
 *  chunks only: boot-time avatars read `mascot-portraits.ts`, which carries the portraits alone. */
const assets = import.meta.glob<string>(['../../assets/mascots/*/*.webp', '!../../assets/mascots/*/portrait-*.webp'], { eager: true, query: '?url', import: 'default' })

export function mascotAsset(mascot: string, part: string): string {
  const url = assets[`../../assets/mascots/${mascot}/${part}.webp`]
  if (!url) throw new Error(`Missing mascot artwork: ${mascot}/${part}`)
  return url
}
