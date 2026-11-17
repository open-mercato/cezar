import { useState } from 'react'
import type { ExtensionPanel } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'

interface ExtensionPanelProps {
  panel: ExtensionPanel
  onAction?: (actionId: string) => Promise<void> | void
  /** Inside a host that already shows the title (a sidebar section): no frame, no heading. */
  compact?: boolean
}

/** Renderer for the intentionally small, declarative extension UI surface. It never uses
 * dangerouslySetInnerHTML and silently ignores unknown blocks from an older/newer extension. */
export function ExtensionPanelView({ panel, onAction, compact = false }: ExtensionPanelProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string>()
  const run = async (id: string) => {
    if (!onAction || busy) return
    setBusy(id); setError(undefined)
    try { await onAction(id) } catch (value) { setError(value instanceof Error ? value.message : 'Extension action failed') } finally { setBusy(null) }
  }
  // Compact: the host (a sidebar section) is already the landmark named after the panel.
  const Frame = compact ? 'div' : 'section'
  return <Frame aria-label={compact ? undefined : panel.title} data-slot="extension-panel" className={compact ? 'flex flex-col gap-2' : 'flex flex-col gap-3 rounded-lg border border-border p-4'}>
    {compact ? null : <h3 className="font-semibold">{panel.title}</h3>}
    {panel.text ? <p className="whitespace-pre-wrap text-sm text-muted-foreground">{panel.text}</p> : null}
    {panel.blocks.map((block, index) => {
      if (block.type === 'text') return <p key={index} className="whitespace-pre-wrap text-sm">{block.text}</p>
      if (block.type === 'status') return <div key={index} className="flex justify-between text-sm"><span>{block.label}</span><span className="font-medium">{block.value}</span></div>
      if (block.type === 'table') return <div key={index} className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{block.columns.map(column => <th key={column} className="p-1 font-medium">{column}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="p-1">{cell}</td>)}</tr>)}</tbody></table></div>
      return null
    })}
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    {panel.actions.length ? <div className="flex flex-wrap gap-2">{panel.actions.map(action => <Button key={action.id} type="button" size="sm" disabled={!onAction || busy !== null} onClick={() => void run(action.id)}>{busy === action.id ? 'Running…' : action.label}</Button>)}</div> : null}
  </Frame>
}
