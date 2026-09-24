import { describe, expect, it } from 'vitest'

import { cn, isHttpUrl } from './utils'

describe('cn', () => {
  it.each([
    { name: 'keeps non-conflicting utilities', input: ['text-sm', 'font-semibold'], expected: 'text-sm font-semibold' },
    { name: 'drops falsy values', input: ['px-2', false, null, undefined, ''], expected: 'px-2' },
    { name: 'flattens arrays', input: [['flex', 'items-center']], expected: 'flex items-center' },
    { name: 'applies object syntax', input: [{ 'bg-muted': true, 'bg-card': false }], expected: 'bg-muted' },
  ])('$name', ({ input, expected }) => {
    expect(cn(...input)).toBe(expected)
  })

  describe('conflict resolution — the later utility wins', () => {
    it.each([
      { name: 'spacing', input: ['p-2', 'p-4'], expected: 'p-4' },
      { name: 'color', input: ['bg-primary', 'bg-contrast'], expected: 'bg-contrast' },
      { name: 'text color', input: ['text-muted-foreground', 'text-foreground'], expected: 'text-foreground' },
      { name: 'radius', input: ['rounded-md', 'rounded-sm'], expected: 'rounded-sm' },
      { name: 'arbitrary height over a scale step', input: ['h-9', 'h-[30px]'], expected: 'h-[30px]' },
      { name: 'arbitrary size over a scale step', input: ['size-9', 'size-[30px]'], expected: 'size-[30px]' },
    ])('$name', ({ input, expected }) => {
      expect(cn(...input)).toBe(expected)
    })

    // Regression: `shadow-modal` is ours, not Tailwind's. Without the extendTailwindMerge config in
    // utils.ts, tailwind-merge reads it as a shadow *color* and lets both classes through.
    it.each([
      { input: ['shadow-xs', 'shadow-modal'], expected: 'shadow-modal' },
      { input: ['shadow-modal', 'shadow-md'], expected: 'shadow-md' },
    ])('custom shadow step: $input', ({ input, expected }) => {
      expect(cn(...input)).toBe(expected)
    })
  })

  it('lets a caller className override a component default', () => {
    expect(cn('rounded-md bg-primary px-3.5', 'bg-contrast')).toBe('rounded-md px-3.5 bg-contrast')
  })
})

// href protocol guard (#431): components render a link only when this passes — React does not
// sanitize href, so a `javascript:` value would execute on click.
describe('isHttpUrl', () => {
  it.each(['https://github.com/acme/demo/pull/1', 'http://localhost:4321', 'HTTPS://EXAMPLE.COM'])(
    'accepts http(s) URL: %s',
    (url) => expect(isHttpUrl(url)).toBe(true),
  )

  // Payloads avoid the literal confirm/alert/prompt tokens the design-guardian scan flags.
  it.each([
    'javascript:void(0)',
    'JavaScript:x=1',
    'data:text/html,<b>x</b>',
    'vbscript:msgbox',
    'file:///etc/passwd',
    '  javascript:void(0)',
    '/relative/path',
    'github.com/acme/demo',
    '',
  ])('refuses non-http(s) / unsafe href: %s', (url) => expect(isHttpUrl(url)).toBe(false))

  it('refuses null/undefined', () => {
    expect(isHttpUrl(null)).toBe(false)
    expect(isHttpUrl(undefined)).toBe(false)
  })
})
