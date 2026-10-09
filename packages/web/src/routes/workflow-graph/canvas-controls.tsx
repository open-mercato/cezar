import { Panel, useReactFlow, useViewport } from '@xyflow/react'
import { LayoutGridIcon, MaximizeIcon, MinusIcon, PlusIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * The canvas's own controls — zoom out, the zoom level (click: back to 100%), zoom in, fit, and
 * (in the editor) tidy — as one button group in the corner. In place of React Flow's `Controls`,
 * so both canvases wear the cockpit's buttons instead of a second, restyled-by-variable set.
 */
export function CanvasControls({ onTidy }: { onTidy?: () => void }) {
  const flow = useReactFlow()
  const { zoom } = useViewport()
  const item = (label: string, onClick: () => void, icon: React.ReactNode) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="outline" size="icon-sm" aria-label={label} onClick={onClick}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
  return (
    <Panel position="bottom-left" className="!m-3 flex items-center gap-2">
      <ButtonGroup data-slot="canvas-controls" className="shadow-xs">
        {item('Zoom out', () => void flow.zoomOut({ duration: 150 }), <MinusIcon />)}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Reset zoom to 100%"
              className="w-14 px-0 text-xs font-normal text-muted-foreground tabular-nums"
              onClick={() => void flow.zoomTo(1, { duration: 150 })}
            >
              {Math.round(zoom * 100)}%
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Reset to 100%</TooltipContent>
        </Tooltip>
        {item('Zoom in', () => void flow.zoomIn({ duration: 150 }), <PlusIcon />)}
        {item('Fit to screen', () => void flow.fitView({ padding: 0.2, maxZoom: 1.2, duration: 200 }), <MaximizeIcon />)}
      </ButtonGroup>
      {onTidy ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Tidy up"
              className="shadow-xs"
              onClick={onTidy}
            >
              <LayoutGridIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Tidy up the layout</TooltipContent>
        </Tooltip>
      ) : null}
    </Panel>
  )
}
