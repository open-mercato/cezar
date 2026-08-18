import { describe, expect, it } from 'vitest'
import { verifyCss } from './verify-css.mjs'

describe('verifyCss', () => {
  it.each([
    ['body{margin:0}', 'document selector'],
    ['.flex{display:flex}', 'selector outside .cezar-root'],
    ['.cezar-root .x{transform:var(--tw-translate-x)}', 'raw --tw-* identifier'],
    ['@supports (--tw-x: 0){.cezar-root{display:block}}', 'raw --tw-* identifier'],
    ['@keyframes spin{to{transform:rotate(1turn)}}', 'unnamespaced keyframe'],
  ])('rejects %s', async (css, reason) => {
    await expect(verifyCss(css)).rejects.toThrow(reason)
  })

  it.each([
    ['.cezar-root,.flex{display:flex}', 'selector outside .cezar-root'],
    ['.cezar-root + .sibling{display:block}', 'selector outside .cezar-root'],
    ['.cezar-root :root{color:red}', 'document selector'],
    ['*{box-sizing:border-box}', 'unscoped universal selector'],
    ['@property --host-x{syntax:"<length>";inherits:false;initial-value:0px}', 'non-Cezar @property'],
    ['.cezar-root{animation-name:spin}', 'unnamespaced keyframe reference'],
    ['@font-face{font-family:"Inter";src:url(inter.woff2)}', 'unnamespaced font family'],
    ['.cezar-root{font-family:"Inter",sans-serif}', 'unnamespaced font family'],
    ['.cezar-root{font:400 1rem/1.5 Inter,sans-serif}', 'unnamespaced font family'],
    [':is(.cezar-root,.host) .x{display:block}', 'selector outside .cezar-root'],
  ])('rejects additional escape %s', async (css, reason) => {
    await expect(verifyCss(css)).rejects.toThrow(reason)
  })

  it('accepts scoped selectors, nested structure, and namespaced globals', async () => {
    const css = [
      '@layer utilities{@supports(display:grid){.cezar-root .grid,.cezar-root:hover{display:grid}}}',
      '.cezar-root *{box-sizing:border-box}',
      '@property --cezar-tw-x{syntax:"<length>";inherits:false;initial-value:0px}',
      '@keyframes cezar-spin{to{transform:rotate(1turn)}}',
      '@font-face{font-family:"cezar-Sans";src:url(cezar.woff2)}',
      '.cezar-root{animation:cezar-spin 1s linear;font-family:"cezar-Sans",system-ui,sans-serif}',
      ':is(.cezar-root,.cezar-root.active) .x,.cezar-root + .cezar-root{display:block}',
      '.cezar-root{font:400 1rem/1.5 cezar-Sans,sans-serif}',
      '.cezar-root{font:var(--cezar-font-sans)}',
    ].join('')

    await expect(verifyCss(css)).resolves.toBeUndefined()
  })
})
