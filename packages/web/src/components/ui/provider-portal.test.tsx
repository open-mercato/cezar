import { cleanup, render, screen, within } from '@testing-library/react'
import { type ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import type { CezarClient, CezarProjectClient } from '@open-mercato/cezar-api-client'
import { CezarProvider } from '@open-mercato/cezar-react'

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from './alert-dialog'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from './dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './sheet'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function fakeCezarClient(): CezarClient {
  const project = (projectId: string | null): CezarProjectClient => ({
    projectId,
    runs: {} as CezarProjectClient['runs'],
    events: {} as CezarProjectClient['events'],
    resolveUrl: (url) => url,
  })
  return {
    identity: 'portal-test',
    baseUrl: '',
    rpc: {} as CezarClient['rpc'],
    events: { forProject: (projectId = null) => project(projectId).events },
    forProject: (projectId = null) => project(projectId),
  } as CezarClient
}

function renderInProvider(children: ReactNode): HTMLElement {
  Object.assign(globalThis, { ResizeObserver: ResizeObserverStub })
  HTMLElement.prototype.scrollIntoView ??= () => undefined
  render(<CezarProvider client={fakeCezarClient()}>{children}</CezarProvider>)
  return screen.getByTestId('cezar-portal')
}

function expectPortalRole(portal: HTMLElement, role: string, name?: string): void {
  const overlay = name === undefined
    ? within(portal).getByRole(role)
    : within(portal).getByRole(role, { name })
  expect(overlay).toBeTruthy()
  expect(document.body.querySelector(':scope > [data-radix-portal]')).toBeNull()
}

describe('provider-owned Radix portals', () => {
  it('contains an opened dialog', () => {
    const portal = renderInProvider(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Dialog title</DialogTitle>
          <DialogDescription>Dialog description</DialogDescription>
        </DialogContent>
      </Dialog>,
    )

    expectPortalRole(portal, 'dialog', 'Dialog title')
  })

  it('contains an opened alert dialog', () => {
    const portal = renderInProvider(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Alert title</AlertDialogTitle>
          <AlertDialogDescription>Alert description</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>,
    )

    expectPortalRole(portal, 'alertdialog', 'Alert title')
  })

  it('contains an opened dropdown menu', () => {
    const portal = renderInProvider(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuItem>Menu item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )

    expectPortalRole(portal, 'menu')
    expect(within(portal).getByRole('menuitem', { name: 'Menu item' })).toBeTruthy()
  })

  it('contains an opened popover', () => {
    const portal = renderInProvider(
      <Popover open>
        <PopoverTrigger>Popover trigger</PopoverTrigger>
        <PopoverContent aria-label="Popover content">Popover body</PopoverContent>
      </Popover>,
    )

    expectPortalRole(portal, 'dialog', 'Popover content')
  })

  it('contains an opened select', () => {
    const portal = renderInProvider(
      <Select open>
        <SelectTrigger aria-label="Select trigger"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="one">One</SelectItem></SelectContent>
      </Select>,
    )

    expectPortalRole(portal, 'listbox')
  })

  it('contains an opened sheet', () => {
    const portal = renderInProvider(
      <Sheet open>
        <SheetContent>
          <SheetTitle>Sheet title</SheetTitle>
          <SheetDescription>Sheet description</SheetDescription>
        </SheetContent>
      </Sheet>,
    )

    expectPortalRole(portal, 'dialog', 'Sheet title')
  })

  it('contains an opened tooltip', () => {
    const portal = renderInProvider(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Tooltip trigger</TooltipTrigger>
          <TooltipContent>Tooltip body</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )

    expectPortalRole(portal, 'tooltip', 'Tooltip body')
  })
})
