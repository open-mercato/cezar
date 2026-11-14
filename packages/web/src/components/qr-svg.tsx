import qrcode from 'qrcode-generator'
import { useMemo } from 'react'

import { cn } from '@/lib/utils'

/** A QR code drawn in the browser, so what it holds never reaches an image service. */
export function QrSvg({ value, label, className }: { value: string; label: string; className?: string }) {
  const { path, size } = useMemo(() => {
    const code = qrcode(0, 'M')
    code.addData(value, 'Byte')
    code.make()
    const count = code.getModuleCount()
    let d = ''
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) if (code.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`
    }
    return { path: d, size: count + 8 }
  }, [value])
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} className={cn('rounded-md bg-qr-ground', className)} shapeRendering="crispEdges">
      <path d={path} className="fill-qr-module" />
    </svg>
  )
}
