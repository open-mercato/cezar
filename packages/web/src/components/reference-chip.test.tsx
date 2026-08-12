import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { ReferenceStatus } from '@open-mercato/cezar-api-client'

import { ReferenceChip } from './reference-chip'
import { REFERENCE_STATUS } from '@/lib/reference-status'

beforeAll(() => {
  // Radix's tooltip arrow measures itself with a ResizeObserver; jsdom has none and never lays
  // anything out.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(cleanup)

const PR = { kind: 'PR' as const, number: 402, url: 'https://github.com/o/r/pull/402' }

function chipOf(ui: React.ReactElement) {
  const { container } = render(ui)
  const chip = container.querySelector('[data-slot="pr-chip"], [data-slot="issue-chip"]')
  if (!chip) throw new Error('ReferenceChip did not render')
  return chip
}

describe('ReferenceChip without a status', () => {
  it('is the neutral violet chip, with the URL as its native tooltip', () => {
    // The pre-status treatment, unchanged: nothing is known about the PR, so nothing is claimed.
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="Add checkout" />)

    expect(chip.getAttribute('data-status')).toBeNull()
    expect(chip.className).toContain('text-violet')
    expect(chip.getAttribute('title')).toBe('https://github.com/o/r/pull/402')
    expect(chip.textContent).toBe('#402')
  })

  it('carries no status glyph', () => {
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="Add checkout" />)
    expect(chip.querySelector('[data-slot="status-dot"]')).toBeNull()
  })
})

describe('ReferenceChip with a status', () => {
  it('paints the tone, the icon and the state — three channels, not one', () => {
    // Color alone is invisible to a colorblind reader and an icon alone is a rebus, so the
    // status has to reach the accessible name too.
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="Add checkout" status="checks-failing" />)

    expect(chip.getAttribute('data-status')).toBe('checks-failing')
    expect(chip.className).toContain('text-danger')
    expect(chip.querySelector('svg')).not.toBeNull()
    expect(chip.getAttribute('aria-label')).toContain('Checks failing')
  })

  it.each([
    ['merged', 'text-violet'],
    ['ready', 'text-success'],
    ['review-required', 'text-info'],
    ['changes-requested', 'text-danger'],
    ['closed', 'text-danger'],
    ['draft', 'text-muted-foreground'],
    ['open', 'text-success'],
    ['completed', 'text-violet'],
    ['not-planned', 'text-muted-foreground'],
  ] as const)('paints %s with the %s tone', (status, tone) => {
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="t" status={status} />)
    expect(chip.className).toContain(tone)
  })

  it('does not paint "waiting for review" the same as "merged"', () => {
    // They were both violet, which read as two shades of done — where one of them is the opposite
    // of done: it is waiting on a person.
    const toneOf = (status: 'review-required' | 'merged') =>
      chipOf(<ReferenceChip reference={PR} taskTitle="t" status={status} />).className
    const waiting = toneOf('review-required')
    cleanup()
    const merged = toneOf('merged')
    expect(waiting).not.toBe(merged)
    expect(waiting).not.toContain('text-violet')
  })

  it('turns the WHOLE chip amber while checks run, and keeps the pulsing dot', () => {
    // A neutral chip with one coloured dot reads as neutral when a table is scanned; the state
    // worth seeing at a glance is "something is happening to this right now".
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="t" status="checks-pending" />)
    const dot = chip.querySelector('[data-slot="status-dot"]')

    expect(chip.className).toContain('text-pending-strong')
    expect(dot?.getAttribute('data-tone')).toBe('pending')
    expect(dot?.className).toContain('animate-pulse')
  })

  it('writes that amber with the INK token, not the dot fill', () => {
    // `--pending` is amber-400 in both themes and fails contrast as text on the light one, which
    // is what the design guardian's `no-amber-text` rule is protecting.
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="t" status="checks-pending" />)
    expect(chip.className).not.toMatch(/\btext-pending\b(?!-strong)/)
  })

  it('drops the native title so the two tooltips cannot fight', () => {
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="t" status="merged" />)
    expect(chip.getAttribute('title')).toBeNull()
    expect(chip.getAttribute('href')).toBe('https://github.com/o/r/pull/402')
  })

  it('explains the status in words before the chip is ever clicked', async () => {
    render(<ReferenceChip reference={PR} taskTitle="t" status="changes-requested" />)
    // Focus, not hover: it is the one trigger every input method shares, and Radix opens on it.
    fireEvent.focus(screen.getByRole('link'))

    await waitFor(() => {
      expect(screen.getAllByRole('tooltip')[0]?.textContent).toContain(
        REFERENCE_STATUS['changes-requested'].hint,
      )
    })
  })

  it('renders a status from a LATER version as the neutral chip rather than throwing', () => {
    // The vocabulary is additive by contract (BACKWARD_COMPATIBILITY.md, `/github/ref-status`):
    // "an unknown one renders neutral". Two real paths reach this bundle with a value it has
    // never heard of — a newer server answering an older tab, and a `sessionStorage` payload a
    // newer cockpit wrote in this same tab — and each used to be a `TypeError` inside the
    // accessible name, which takes the whole table down rather than the one chip.
    const chip = chipOf(
      <ReferenceChip reference={PR} taskTitle="Add checkout" status={'queued-for-merge' as ReferenceStatus} />,
    )

    expect(chip.className).toContain('text-violet')
    expect(chip.querySelector('svg[data-slot="status-dot"]')).toBeNull()
    // The neutral chip's own tooltip, not a described status: the URL, exactly as before statuses.
    expect(chip.getAttribute('title')).toBe('https://github.com/o/r/pull/402')
    expect(chip.getAttribute('aria-label')).toBe('Open the pull request for Add checkout')
  })

  it('keeps a non-http reference inert while still saying where it stands', () => {
    // #431: a transcript-scraped `javascript:` URL degrades to text — it must not gain a link
    // just because a status arrived.
    const chip = chipOf(
      <ReferenceChip
        reference={{ kind: 'Issue', number: 12, url: 'javascript:void(0)' }}
        taskTitle="t"
        status="completed"
      />,
    )
    expect(chip.tagName).toBe('SPAN')
    expect(chip.getAttribute('data-status')).toBe('completed')
  })
})
