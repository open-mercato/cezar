import { describe, expect, it } from 'vitest'

import {
  DESIGN_HEADING,
  formatDesignPicks,
  messageWithDesignPicks,
  parseDesignPick,
  parseDesignPicks,
  pickLabel,
  type DesignPick,
} from './design-picks'

/**
 * Design Mode picks (spec `.ai/specs/2026-10-09-design-mode.md`): what a framed page may hand the
 * cockpit, and what the agent is then told. The sender is a page cezar does not control, so the
 * cases that matter are the hostile and the malformed ones.
 */

const pick = (over: Partial<DesignPick> = {}): DesignPick => ({
  id: 'a',
  url: 'http://localhost:5173/settings',
  selector: 'main > form.settings > button.btn-primary',
  tag: 'button',
  text: 'Save',
  html: '<button class="btn-primary">Save</button>',
  styles: { color: 'rgb(255, 255, 255)', 'border-radius': '6px' },
  rect: { x: 240, y: 512, width: 120, height: 32 },
  viewport: { width: 1280, height: 720 },
  components: ['Button', 'SettingsForm'],
  source: 'src/ui/button.tsx:14',
  ...over,
})

describe('parseDesignPick', () => {
  it('keeps a well-formed element', () => {
    const { id: _id, ...sent } = pick()
    expect(parseDesignPick(sent)).toEqual(sent)
  })

  it.each([null, undefined, 'button', 42, [], {}, { selector: 'a' }, { tag: 'a' }, { selector: 7, tag: 'a' }])(
    'answers null for what is not an element: %j',
    (raw) => {
      expect(parseDesignPick(raw)).toBeNull()
    },
  )

  it('bounds every field a page controls', () => {
    const parsed = parseDesignPick({
      selector: 's'.repeat(5000),
      tag: 't'.repeat(500),
      url: 'u'.repeat(9000),
      text: 'x'.repeat(9000),
      html: 'h'.repeat(90_000),
      source: 'f'.repeat(9000),
      components: Array.from({ length: 50 }, () => 'C'.repeat(500)),
      styles: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`prop-${String.fromCharCode(97 + (i % 26))}${'x'.repeat(i % 5)}`, 'v'.repeat(900)])),
    })!
    expect(parsed.selector).toHaveLength(400)
    expect(parsed.tag).toHaveLength(40)
    expect(parsed.url).toHaveLength(2000)
    expect(parsed.text).toHaveLength(200)
    expect(parsed.html).toHaveLength(1600)
    expect(parsed.source).toHaveLength(300)
    expect(parsed.components).toHaveLength(6)
    expect(parsed.components[0]).toHaveLength(80)
    expect(Object.keys(parsed.styles).length).toBeLessThanOrEqual(30)
    expect(Object.values(parsed.styles).every((value) => value.length <= 160)).toBe(true)
  })

  it('drops style names that are not property names, and non-numeric geometry', () => {
    const parsed = parseDesignPick({
      selector: 'a',
      tag: 'a',
      styles: { color: 'red', 'bad name\n- injected': 'x', width: 12 },
      rect: { x: 'left', y: Number.NaN, width: 10.6, height: Infinity },
    })!
    expect(parsed.styles).toEqual({ color: 'red' })
    expect(parsed.rect).toEqual({ x: 0, y: 0, width: 11, height: 0 })
  })
})

describe('parseDesignPicks', () => {
  it('reads back what was stored and drops what is malformed', () => {
    const stored = JSON.stringify([pick(), { selector: 'x', tag: 'p' }, { id: 'b' }, pick({ id: 'c' })])
    expect(parseDesignPicks(stored).map((item) => item.id)).toEqual(['a', 'c'])
  })

  it.each(['', 'not json', '{}', 'null'])('answers an empty list for %j', (text) => {
    expect(parseDesignPicks(text)).toEqual([])
  })
})

describe('pickLabel', () => {
  it('leads with the innermost component when there is one', () => {
    expect(pickLabel(pick())).toBe('Button · button.btn-primary')
    expect(pickLabel(pick({ components: [] }))).toBe('button.btn-primary')
  })
})

describe('formatDesignPicks', () => {
  it('describes an element the way an agent can find it', () => {
    expect(formatDesignPicks([pick()])).toBe(
      [
        DESIGN_HEADING,
        '',
        '- `main > form.settings > button.btn-primary` on http://localhost:5173/settings',
        '  component: SettingsForm › Button (src/ui/button.tsx:14)',
        '  box: 120×32 at 240,512 (viewport 1280×720)',
        '  text: "Save"',
        '  styles: color: rgb(255, 255, 255); border-radius: 6px',
        '',
        '  ```html',
        '  <button class="btn-primary">Save</button>',
        '  ```',
      ].join('\n'),
    )
  })

  it('omits what the page did not provide', () => {
    const text = formatDesignPicks([pick({ components: [], source: '', text: '', styles: {} })])
    expect(text).not.toMatch(/component:|source:|text:|styles:/)
  })

  it('fences markup with a fence its content cannot close', () => {
    const text = formatDesignPicks([pick({ html: '<pre>```\n````</pre>' })])
    expect(text).toContain('  `````html\n  <pre>```\n  ````</pre>\n  `````')
  })

  it('is empty for no picks', () => {
    expect(formatDesignPicks([])).toBe('')
  })
})

describe('messageWithDesignPicks', () => {
  it('keeps the typed text first — a leading /skill must stay leading', () => {
    const message = messageWithDesignPicks('/fix-ui make it bigger', [pick()])
    expect(message.startsWith('/fix-ui make it bigger\n\n' + DESIGN_HEADING)).toBe(true)
  })

  it('is the block alone when nothing was typed, and the text alone when nothing was picked', () => {
    expect(messageWithDesignPicks('  ', [pick()]).startsWith(DESIGN_HEADING)).toBe(true)
    expect(messageWithDesignPicks('hello', [])).toBe('hello')
  })

  it('refuses, with a reason, a message the server would reject', () => {
    expect(() => messageWithDesignPicks('x'.repeat(99_990), [pick()])).toThrow(/selected element attached/)
  })
})
