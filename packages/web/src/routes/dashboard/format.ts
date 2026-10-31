export function formatAmount(value: number | null | undefined, usd = false) {
  if (value == null) return 'Unavailable'
  if (!usd) return value.toLocaleString('en-US')
  return `$${value.toFixed(value === 0 || value >= 1 ? 2 : Math.min(20, Math.max(4, Math.ceil(-Math.log10(value)) + 1)))}`
}

export function formatHours(value: number | null) {
  if (value === null) return 'Unavailable'
  return value < 1
    ? `${Math.round(value * 60)}m`
    : value < 48
      ? `${value.toFixed(1)}h`
      : `${(value / 24).toFixed(1)}d`
}
