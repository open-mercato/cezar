import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { BranchChip } from './branch-chip'
import { Chip, chipClass } from './chip'
import { FacetFilter, ToggleChip } from './facet-filter'
import { Pill } from './pill'
import { ReferenceChip } from './reference-chip'
import { Segmented } from './segmented'
import { Badge } from './ui/badge'

afterEach(cleanup)

/**
 * One visual grammar across the pill families (UI strategy, "Pills/chips, three families"):
 * row pills are 28px (`h-7`), inline chips 20px (`h-5`), every one of them `rounded-full` on the
 * 13px `text-ui` size, and mono ONLY where the value is code. Status colour is never painted by
 * a pill — it rides `StatusDot`'s tone.
 */
const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`) as HTMLElement

describe('pill families share one grammar', () => {
  it('row pills (Chip, PickerPill via chipClass, FacetFilter, ToggleChip, Segmented) are h-7 text-ui', () => {
    render(
      <>
        <Chip>quick-task</Chip>
        <FacetFilter slot="status" label="Status" options={[]} selected={[]} onToggle={() => {}} onClear={() => {}} />
        <ToggleChip slot="tag" label="infra" selected={false} onToggle={() => {}} />
        <Segmented slot="view" label="View" value="a" options={[{ value: 'a', label: 'A' }]} onChange={() => {}} />
      </>,
    )
    for (const el of [slot('chip'), slot('facet-status'), slot('tag')]) {
      expect(el.className).toContain('h-7')
      expect(el.className).toContain('rounded-full')
      expect(el.className).toContain('text-ui')
      expect(el.className).not.toContain('font-mono')
    }
    expect(chipClass).toContain('h-7')
    expect(chipClass).toContain('text-ui')
    const segment = slot('view').querySelector('button') as HTMLElement
    expect(segment.className).toContain('h-7')
    expect(segment.className).toContain('text-ui')
  })

  it('inline chips (Pill, BranchChip, ReferenceChip, Badge) are h-5 rounded-full text-ui', () => {
    render(
      <>
        <Pill dot="success">Done</Pill>
        <BranchChip>cez/207a3912</BranchChip>
        <ReferenceChip reference={{ kind: 'PR', number: 402 }} taskTitle="t" />
        <Badge variant="outline">3</Badge>
      </>,
    )
    for (const el of [slot('pill'), slot('branch-chip'), slot('pr-chip'), slot('badge')]) {
      expect(el.className).toContain('h-5')
      expect(el.className).toContain('rounded-full')
      expect(el.className).toContain('text-ui')
    }
  })

  it('mono only when the value is code: branch and reference numbers, never status words or counts', () => {
    render(
      <>
        <Pill>Running</Pill>
        <BranchChip>main</BranchChip>
        <ReferenceChip reference={{ kind: 'Issue', number: 12 }} taskTitle="t" />
        <Badge>7</Badge>
      </>,
    )
    expect(slot('branch-chip').className).toContain('font-mono')
    expect(slot('issue-chip').className).toContain('font-mono')
    expect(slot('pill').className).not.toContain('font-mono')
    expect(slot('badge').className).not.toContain('font-mono')
  })

  it('a status pill paints the dot, never its own fill', () => {
    render(<Pill dot="danger">Failed</Pill>)
    const pill = screen.getByText('Failed')
    expect(pill.className).toContain('bg-muted')
    expect(pill.className).not.toMatch(/\bbg-danger\b/)
    expect(pill.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('danger')
  })
})
