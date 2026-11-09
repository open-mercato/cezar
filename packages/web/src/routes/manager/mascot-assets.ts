/** Vite owns fingerprinting and the server's existing /assets/:file route serves every part. */
const assets = import.meta.glob<string>('../../assets/mascots/*/*.webp', { eager: true, query: '?url', import: 'default' })

export function mascotAsset(mascot: string, part: string): string {
  const url = assets[`../../assets/mascots/${mascot}/${part}.webp`]
  if (!url) throw new Error(`Missing mascot artwork: ${mascot}/${part}`)
  return url
}
