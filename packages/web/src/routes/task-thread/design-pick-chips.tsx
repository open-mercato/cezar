import { MousePointerClickIcon, XIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

import { pickLabel, type DesignPick } from './design-picks'

/**
 * The Design Mode picks as draft items in the thread composer — one chip per element, beside the
 * diff-comment chips and built like them. The tooltip shows what the agent will be told about
 * the element; the ✕ drops just that one.
 */
export function DesignPickChips({
  picks,
  onRemove,
}: {
  picks: readonly DesignPick[]
  onRemove: (id: string) => void
}) {
  if (picks.length === 0) return null
  return (
    <TooltipProvider delayDuration={300}>
      {picks.map((pick) => {
        const label = pickLabel(pick)
        return (
          <Tooltip key={pick.id}>
            <TooltipTrigger asChild>
              <span
                data-slot="design-pick-chip"
                // Focusable so the tooltip — the only place the element's detail shows — is
                // reachable from the keyboard, as the diff chips' link makes theirs.
                tabIndex={0}
                aria-label={`Selected element ${label}`}
                className="flex h-8 max-w-[260px] items-center overflow-hidden rounded-md border border-border bg-muted/40 text-xs text-foreground"
              >
                <span aria-hidden="true" className="flex h-full items-center border-r border-border px-2 text-muted-foreground">
                  <MousePointerClickIcon className="size-3.5" />
                </span>
                <span className="min-w-0 truncate px-2 font-medium">{label}</span>
                <Button
                  type="button"
                  aria-label={`Remove selected element ${label}`}
                  onClick={() => onRemove(pick.id)}
                  variant="ghost"
                  className="h-full rounded-none px-1.5 text-soft-foreground"
                >
                  <XIcon aria-hidden="true" className="size-3.5" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6} className="max-w-[360px] text-left">
              <div data-slot="design-pick-tooltip" className="flex flex-col gap-1">
                <span className="font-mono text-[11px] break-all text-contrast-foreground/80">{pick.selector}</span>
                {pick.url ? <span className="text-[11px] break-all text-contrast-foreground/80">{pick.url}</span> : null}
                <span className="line-clamp-5 font-mono text-[11px] break-all whitespace-pre-wrap">{pick.html}</span>
              </div>
            </TooltipContent>
          </Tooltip>
        )
      })}
    </TooltipProvider>
  )
}
