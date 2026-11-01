// The geometry of every state, from `layout.json` and the housing the shell reports. Pure, so the
// states can be tested without a page.

/** A pill exactly behind the camera: where shapes grow from and fold back into. */
export function tucked(layout, housing) {
  const centre = layout.window.width / 2
  return { x: centre - housing.width / 2, y: housing.top, width: housing.width, height: housing.height }
}

function pill2Rect(layout, housing, island, minis, overflow) {
  if (minis === 0) return null
  const { placement, gap, inset, padding, mini, miniGap, countWidth, belowHeight } = layout.pill2
  const width = padding * 2 + minis * mini + (minis - 1) * miniGap + (overflow > 0 ? countWidth + miniGap : 0)
  if (placement === 'below') {
    return { x: layout.window.width / 2 - width / 2, y: housing.top + housing.height + gap, width, height: belowHeight }
  }
  const pad = housing.width > 0 ? inset : 0
  return { x: island.x + island.width + gap, y: housing.top + pad, width, height: housing.height - pad * 2 }
}

export function computeShapes(layout, housing, { expanded, rows, textWidth, minis, overflow }) {
  const centre = layout.window.width / 2
  if (expanded) {
    const { width, headerFloating, rowHeight, maxRows, paddingBottom } = layout.expanded
    const header = housing.width > 0 ? housing.height : headerFloating
    const height = header + Math.min(rows, maxRows) * rowHeight + paddingBottom
    return { island: { x: centre - width / 2, y: housing.top, width, height }, pill2: null, header }
  }
  const { leftWing, textPadding, textMin, textMax } = layout.pill1
  const right = Math.min(textMax, Math.max(textMin, textWidth + textPadding))
  const width = leftWing + housing.width + right
  // The camera stays centred even though the wings differ; a floating capsule centres itself.
  const x = housing.width > 0 ? centre - housing.width / 2 - leftWing : centre - width / 2
  const island = { x, y: housing.top, width, height: housing.height }
  return { island, pill2: pill2Rect(layout, housing, island, minis, overflow), header: housing.height }
}
