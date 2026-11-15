// A computer's automatic avatar (switcher spec, parent task 2fb255e3): byte-identical on web,
// Android and iOS, so the cockpit header and the native list agree without sharing any state.

export const DEVICE_PALETTE = ['#7c6cf0', '#e0912a', '#2fb862', '#2a9fd8', '#e05a73', '#22b3a0'] as const

/** h = (h*31 + c) mod 2^32 over the trimmed name's UTF-16 code units, then the palette slot. */
export function deviceColor(name: string): string {
  const trimmed = name.trim()
  let h = 0
  for (let i = 0; i < trimmed.length; i++) h = (Math.imul(h, 31) + trimmed.charCodeAt(i)) >>> 0
  return DEVICE_PALETTE[h % DEVICE_PALETTE.length]!
}

/** Each word's first code point, letters and digits only, the first two, uppercased. '' = no initials. */
export function deviceInitials(name: string): string {
  const firsts = name.trim().split(/\s+/u).map((word) => String.fromCodePoint(word.codePointAt(0) ?? 0))
  return firsts.filter((ch) => /^[\p{L}\p{N}]$/u.test(ch)).slice(0, 2).join('').toUpperCase()
}
