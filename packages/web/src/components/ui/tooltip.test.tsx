import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { IconTooltip } from './icon-tooltip'
import { TOOLTIP_MAX_WIDTH_CLASS, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

afterEach(cleanup)

const content = () => document.querySelector('[data-slot="tooltip-content"]') as HTMLElement

describe('Tooltip', () => {
  // UI strategy, "Tooltips": one component, one line, one max width — nobody re-shapes it per call.
  it('renders one shape: 12px label on the contrast surface, capped at the shared max width', () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Pin</TooltipTrigger>
          <TooltipContent>Pin to the top of the list</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )
    const el = content()
    expect(el.textContent).toContain('Pin to the top of the list')
    expect(el.className).toContain('text-label')
    expect(el.className).toContain('bg-contrast')
    expect(el.className).toContain(TOOLTIP_MAX_WIDTH_CLASS)
    expect(TOOLTIP_MAX_WIDTH_CLASS).toBe('max-w-[280px]')
  })

  it('IconTooltip is the same shape around a trigger that keeps its accessible name', () => {
    render(
      <IconTooltip label="Hide sidebar (⌘B)">
        <button type="button" aria-label="Hide sidebar">
          x
        </button>
      </IconTooltip>,
    )
    const trigger = document.querySelector('button[aria-label="Hide sidebar"]') as HTMLElement
    expect(trigger.getAttribute('data-slot')).toBe('tooltip-trigger')
    expect(trigger.getAttribute('title')).toBeNull()
  })
})
