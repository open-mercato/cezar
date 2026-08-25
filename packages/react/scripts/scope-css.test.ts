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

  it('binds every non-Cezar custom property declaration, registration, and reference', async () => {
    const css = [
      '@property --foreign-size{syntax:"<length>";inherits:false;initial-value:0px}',
      '.tokens{--spacing:.25rem;--ease-in:cubic-bezier(.4,0,1,1);--cezar-public:1rem;',
      'gap:var(--spacing);transition-timing-function:var(--ease-in);width:var(--foreign-size);height:var(--cezar-public)}',
    ].join('')

    expect(await scopeCss(css)).toBe([
      '@property --cezar-tw-foreign-size{syntax:"<length>";inherits:false;initial-value:0px}',
      '.cezar-root .tokens{--cezar-tw-spacing:.25rem;--cezar-tw-ease-in:cubic-bezier(.4,0,1,1);--cezar-public:1rem;',
      'gap:var(--cezar-tw-spacing);transition-timing-function:var(--cezar-tw-ease-in);width:var(--cezar-tw-foreign-size);height:var(--cezar-public)}',
    ].join(''))
  })

  it('preserves Radix runtime properties while namespacing repository-owned properties', async () => {
    const css = [
      '.popover{--radix-popover-content-transform-origin:top left;transform-origin:var(--radix-popover-content-transform-origin);',
      '--spacing:.25rem;gap:var(--spacing)}',
    ].join('')

    expect(await scopeCss(css)).toBe([
      '.cezar-root .popover{--radix-popover-content-transform-origin:top left;transform-origin:var(--radix-popover-content-transform-origin);',
      '--cezar-tw-spacing:.25rem;gap:var(--cezar-tw-spacing)}',
    ].join(''))
  })

  it('renames complete font-family groups only in font semantic positions', async () => {
    const css = [
      '@font-face{font-family:"Cezar Sans";src:url(cezar.woff2)}',
      '.copy{font-family:Cezar Sans,"Other Font",var(--font-host),sans-serif;',
      'font:400 1rem/1.5 Cezar Sans,"Other Font",var(--font-host),sans-serif;',
      'content:"Cezar Sans";--label:"Cezar Sans"}',
    ].join('')

    expect(await scopeCss(css)).toBe([
      '@font-face{font-family:"cezar-Cezar Sans";src:url(cezar.woff2)}',
      '.cezar-root .copy{font-family:cezar-Cezar Sans,"cezar-Other Font",var(--cezar-tw-font-host),sans-serif;',
      'font:400 1rem/1.5 cezar-Cezar Sans,"cezar-Other Font",var(--cezar-tw-font-host),sans-serif;',
      'content:"Cezar Sans";--cezar-tw-label:"Cezar Sans"}',
    ].join(''))
  })

  it('preserves an ancestor root across sibling combinators and recognizes a root on the right', async () => {
    const css = [
      '.peer:checked ~ .target,.a + .b,.cell || .other,',
      '.cezar-root .peer:checked ~ .target,.cezar-root > .group:hover + .target,',
      '.host + .cezar-root,:is(.cezar-root,.cezar-root.active) .x',
      '{display:block}',
    ].join('')

    const scoped = [
      '.cezar-root .peer:checked ~ .target,.cezar-root .a + .b,.cezar-root .cell || .other,',
      '.cezar-root .peer:checked ~ .target,.cezar-root > .group:hover + .target,',
      '.host + .cezar-root,:is(.cezar-root,.cezar-root.active) .x',
      '{display:block}',
    ].join('')

    expect(await scopeCss(css)).toBe(scoped)
    expect(await scopeCss(scoped)).toBe(scoped)
  })

  it('scopes common Tailwind peer and group selector shapes exactly once', async () => {
    const css = [
      '.peer-checked\\:block:is(:where(.peer):checked~*),',
      '.group-hover\\:block:is(:where(.group):hover *)',
      '{display:block}',
    ].join('')
    const scoped = [
      '.cezar-root .peer-checked\\:block:is(:where(.peer):checked~*),',
      '.cezar-root .group-hover\\:block:is(:where(.group):hover *)',
      '{display:block}',
    ].join('')

    expect(await scopeCss(css)).toBe(scoped)
    expect(await scopeCss(scoped)).toBe(scoped)
  })

  it('renames keyframes only in animation semantic positions', async () => {
    const css = [
      '@keyframes pulse{to{opacity:.5}}',
      '.pulse{animation:pulse 1s;animation-name:pulse;--animate-pulse:pulse 1s;',
      'content:"pulse";color:pulse;--label:pulse}',
    ].join('')

    expect(await scopeCss(css)).toBe([
      '@keyframes cezar-pulse{to{opacity:.5}}',
      '.cezar-root .pulse{animation:cezar-pulse 1s;animation-name:cezar-pulse;--cezar-tw-animate-pulse:cezar-pulse 1s;',
      'content:"pulse";color:pulse;--cezar-tw-label:pulse}',
    ].join(''))
  })

  it('is deterministic when an already-scoped artifact is processed again', async () => {
    const css = '@property --tw-x{syntax:"*";inherits:false}@keyframes pulse{to{opacity:.5}}.pulse{--tw-x:1;animation:pulse 1s}'
    const scoped = await scopeCss(css)

    expect(await scopeCss(scoped)).toBe(scoped)
  })
})
