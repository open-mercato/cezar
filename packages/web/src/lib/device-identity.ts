// A computer's automatic avatar (switcher spec, parent task 2fb255e3): byte-identical on web,
// Android and iOS, so the cockpit header and the native list agree without sharing any state.

/** The palette's size; its colours are the `--color-device-N` tokens in styles/index.css. */
export const DEVICE_PALETTE_SIZE = 6

/** h = (h*31 + c) mod 2^32 over the trimmed name's UTF-16 code units, then the palette slot (0-based). */
export function deviceColorIndex(name: string): number {
  const trimmed = name.trim()
  let h = 0
  for (let i = 0; i < trimmed.length; i++) h = (Math.imul(h, 31) + trimmed.charCodeAt(i)) >>> 0
  return h % DEVICE_PALETTE_SIZE
}

/** The CSS colour for the name's slot. */
export const deviceColor = (name: string): string => `var(--color-device-${deviceColorIndex(name) + 1})`

/** Each word's first code point, letters and digits only, the first two, uppercased. '' = no initials. */
export function deviceInitials(name: string): string {
  const firsts = name.trim().split(/\s+/u).map((word) => String.fromCodePoint(word.codePointAt(0) ?? 0))
  return firsts.filter((ch) => /^[\p{L}\p{N}]$/u.test(ch)).slice(0, 2).join('').toUpperCase()
}
