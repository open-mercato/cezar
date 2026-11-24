import type { ComponentProps } from 'react'
import { mascotPortrait } from './mascot-portraits'

/** `sizes` is the drawn CSS width; srcset then picks 96, 192 or 256 px for the screen's density. */
export function MascotPortrait({ mascot, sizes = '56px', ...props }: { mascot: string } & Omit<ComponentProps<'img'>, 'src' | 'srcSet'>) {
  const { src, srcSet } = mascotPortrait(mascot)
  return <img alt="" {...props} src={src} srcSet={srcSet} sizes={sizes} />
}
