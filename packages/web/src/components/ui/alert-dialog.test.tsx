import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from './alert-dialog'

afterEach(cleanup)

function renderConfirm(variant?: 'contrast' | 'destructive') {
  render(
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogTitle>Delete this task?</AlertDialogTitle>
        <AlertDialogDescription>The worktree and its history are removed. This cannot be undone.</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={variant}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>,
  )
}

describe('AlertDialog', () => {
  // UI strategy, "Dialogs": Cancel left of the primary. The footer keeps DOM order on desktop, so
  // rendering Cancel first puts it left — a row-reverse here would silently flip every dialog.
  it('keeps Cancel left of the primary (DOM order, no row-reverse on desktop)', () => {
    renderConfirm()
    const footer = document.querySelector('[data-slot="alert-dialog-footer"]') as HTMLElement
    expect(footer.className).toContain('sm:flex-row')
    expect(footer.className).not.toContain('sm:flex-row-reverse')
    const buttons = Array.from(footer.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons).toEqual(['Cancel', 'Delete'])
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain('border-border')
  })

  it('confirms with the contrast button by default', () => {
    renderConfirm()
    const action = screen.getByRole('button', { name: 'Delete' })
    expect(action.dataset.variant).toBe('contrast')
    expect(action.className).toContain('bg-contrast')
  })

  it('offers the filled destructive variant for a deletion', () => {
    renderConfirm('destructive')
    const action = screen.getByRole('button', { name: 'Delete' })
    expect(action.dataset.variant).toBe('destructive')
    expect(action.className).toContain('bg-danger')
    expect(action.className).toContain('text-danger-foreground')
  })
})
