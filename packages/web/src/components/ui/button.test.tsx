import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Button } from './button'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

describe('Button', () => {
  it('defaults to the primary variant at the default size', () => {
    render(<Button>Run</Button>)
    const button = screen.getByRole('button', { name: 'Run' })

    expect(button.dataset.variant).toBe('primary')
    expect(button.dataset.size).toBe('default')
    expect(button.className).toContain('bg-primary')
    expect(button.className).toContain('h-9')
  })

  describe('variant → class mapping', () => {
    it.each([
      { variant: 'primary', expected: ['bg-primary', 'text-primary-foreground'] },
      { variant: 'contrast', expected: ['bg-contrast', 'text-contrast-foreground'] },
      { variant: 'outline', expected: ['border', 'border-input', 'bg-card'] },
      { variant: 'ghost', expected: ['text-muted-foreground'] },
      { variant: 'danger-ghost', expected: ['text-danger'] },
    ] as const)('$variant', ({ variant, expected }) => {
      render(<Button variant={variant}>Label</Button>)
      const button = screen.getByRole('button')

      expect(button.dataset.variant).toBe(variant)
      for (const cls of expected) expect(button.classList.contains(cls)).toBe(true)
    })
  })

  describe('size → class mapping', () => {
    it.each([
      { size: 'default', expected: ['h-9', 'px-3.5'] },
      { size: 'sm', expected: ['h-8', 'px-2.5'] },
      { size: 'xs', expected: ['h-6', 'rounded-sm'] },
      { size: 'icon', expected: ['size-9'] },
      { size: 'icon-sm', expected: ['size-8'] },
      { size: 'icon-xs', expected: ['size-6', 'rounded-sm'] },
    ] as const)('$size', ({ size, expected }) => {
      render(<Button size={size}>Label</Button>)
      const button = screen.getByRole('button')

      expect(button.dataset.size).toBe(size)
      for (const cls of expected) expect(button.classList.contains(cls)).toBe(true)
    })
  })

  it.each(['xs', 'icon-xs'] as const)('lets the %s size override the default control radius', (size) => {
    render(<Button size={size}>Label</Button>)
    // `rounded-md` is the base; the extra-small sizes must win the merge rather than coexist.
    const button = screen.getByRole('button')
    expect(button.classList.contains('rounded-sm')).toBe(true)
    expect(button.classList.contains('rounded-md')).toBe(false)
  })

  it('keeps the control radius on sm — only the extra-small sizes tighten it', () => {
    render(<Button size="sm">Label</Button>)
    expect(screen.getByRole('button').classList.contains('rounded-md')).toBe(true)
  })

  it('lets a caller className override a variant class', () => {
    render(<Button className="bg-muted">Label</Button>)
    const button = screen.getByRole('button')

    expect(button.className).toContain('bg-muted')
    expect(button.className).not.toContain('bg-primary')
  })

  it('renders the child element instead of a button when asChild is set', () => {
    render(
      <Button asChild variant="contrast">
        <a href="/tasks">Tasks</a>
      </Button>
    )

    const link = screen.getByRole('link', { name: 'Tasks' })
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/tasks')
    expect(link.className).toContain('bg-contrast')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('is inert while disabled', () => {
    render(<Button disabled>Label</Button>)
    const button = screen.getByRole('button')

    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.className).toContain('disabled:opacity-50')
  })
})
