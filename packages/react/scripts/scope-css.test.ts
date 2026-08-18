import { describe, expect, it } from 'vitest'
import { scopeCss } from './scope-css.mjs'

describe('scopeCss', () => {
  it('scopes every comma branch and preserves nested at-rules', async () => {
    const css = '@layer utilities{@media (width >= 40rem){.flex,:hover{display:flex}}}'

    expect(await scopeCss(css)).toBe(
      '@layer utilities{@media (width >= 40rem){.cezar-root .flex,.cezar-root :hover{display:flex}}}',
    )
  })

  it('normalizes root selectors without double-prefixing and contains universals', async () => {
    const css = ':root,:host,.cezar-root,.cezar-root .x,*::before{box-sizing:border-box}'

    expect(await scopeCss(css)).toBe(
      '.cezar-root,.cezar-root,.cezar-root,.cezar-root .x,.cezar-root *::before{box-sizing:border-box}',
    )
  })

  it('renames Tailwind properties and keyframes in definitions and references', async () => {
    const css = [
      '@property --tw-translate-x{syntax:"<length>";inherits:false;initial-value:0px}',
      '@keyframes spin{to{transform:translateX(var(--tw-translate-x)) rotate(1turn)}}',
      '.animate{--tw-translate-x:1px;animation:spin 1s linear;animation-name:spin}',
    ].join('')

    expect(await scopeCss(css)).toBe([
      '@property --cezar-tw-translate-x{syntax:"<length>";inherits:false;initial-value:0px}',
      '@keyframes cezar-spin{to{transform:translateX(var(--cezar-tw-translate-x)) rotate(1turn)}}',
      '.cezar-root .animate{--cezar-tw-translate-x:1px;animation:cezar-spin 1s linear;animation-name:cezar-spin}',
    ].join(''))
  })

  it('renames declared font families and every parsed reference', async () => {
    const css = [
      '@font-face{font-family:"Cezar Sans";src:url(cezar.woff2)}',
      '.copy{font-family:"Cezar Sans",sans-serif;font:400 1rem/1.5 "Cezar Sans"}',
    ].join('')

    expect(await scopeCss(css)).toBe([
      '@font-face{font-family:"cezar-Cezar Sans";src:url(cezar.woff2)}',
      '.cezar-root .copy{font-family:"cezar-Cezar Sans",sans-serif;font:400 1rem/1.5 "cezar-Cezar Sans"}',
    ].join(''))
  })

  it('recognizes root guarantees inside selector functions and after sibling branches', async () => {
    const css = ':is(.cezar-root,.cezar-root.active) .x,.cezar-root + .cezar-root{display:block}'

    expect(await scopeCss(css)).toBe(css)
  })

  it('is deterministic when an already-scoped artifact is processed again', async () => {
    const css = '@property --tw-x{syntax:"*";inherits:false}@keyframes pulse{to{opacity:.5}}.pulse{--tw-x:1;animation:pulse 1s}'
    const scoped = await scopeCss(css)

    expect(await scopeCss(scoped)).toBe(scoped)
  })
})
