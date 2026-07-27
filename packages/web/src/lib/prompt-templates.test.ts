import { describe, expect, it } from 'vitest'

import {
  autoApplyText,
  DEFAULT_PROMPT_TEMPLATES,
  insertTemplate,
  makeTemplateId,
  normalizePromptTemplates,
  resolveAutoApply,
  templatesForSkills,
  type PromptTemplate,
} from './prompt-templates'

describe('normalizePromptTemplates', () => {
  it('an absent key (undefined) falls back to the built-in defaults', () => {
    expect(normalizePromptTemplates(undefined)).toEqual(DEFAULT_PROMPT_TEMPLATES)
  })

  it('garbage (not an array) also falls back to the defaults — corruption must not brick the menu', () => {
    expect(normalizePromptTemplates('nope')).toEqual(DEFAULT_PROMPT_TEMPLATES)
    expect(normalizePromptTemplates({ not: 'an array' })).toEqual(DEFAULT_PROMPT_TEMPLATES)
    expect(normalizePromptTemplates(42)).toEqual(DEFAULT_PROMPT_TEMPLATES)
  })

  it('a deliberately empty array stays empty — the defaults must not reappear underneath it', () => {
    expect(normalizePromptTemplates([])).toEqual([])
  })

  it('parses a valid list verbatim', () => {
    const raw = [{ id: 'a', label: 'A', text: 'Do A.' }]
    expect(normalizePromptTemplates(raw)).toEqual(raw)
  })

  it('skips malformed entries but keeps the valid ones', () => {
    const raw = [
      { id: 'a', label: 'A', text: 'Do A.' },
      { id: 'b', label: '', text: 'missing label' },
      { id: '', label: 'no id', text: 'missing id' },
      { label: 'no text field at all' },
      'not an object',
      42,
      null,
      { id: 'c', label: 'C', text: 'Do C.' },
    ]
    expect(normalizePromptTemplates(raw)).toEqual([
      { id: 'a', label: 'A', text: 'Do A.' },
      { id: 'c', label: 'C', text: 'Do C.' },
    ])
  })

  it('drops a duplicate id, keeping the first occurrence', () => {
    const raw = [
      { id: 'a', label: 'First', text: 'one' },
      { id: 'a', label: 'Second', text: 'two' },
    ]
    expect(normalizePromptTemplates(raw)).toEqual([{ id: 'a', label: 'First', text: 'one' }])
  })

  it('trims and caps label/text length', () => {
    const raw = [{ id: 'a', label: `  ${'x'.repeat(90)}  `, text: `  ${'y'.repeat(2010)}  ` }]
    const [template] = normalizePromptTemplates(raw)
    expect(template?.label).toHaveLength(80)
    expect(template?.text).toHaveLength(2000)
  })

  it('caps the list at 50 entries', () => {
    const raw = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, label: `T${i}`, text: `do ${i}` }))
    expect(normalizePromptTemplates(raw)).toHaveLength(50)
  })

  it('does not mutate the shared DEFAULT_PROMPT_TEMPLATES export on repeated calls', () => {
    const first = normalizePromptTemplates(undefined)
    first[0]!.label = 'mutated'
    expect(normalizePromptTemplates(undefined)[0]?.label).not.toBe('mutated')
  })
})

describe('makeTemplateId', () => {
  it('produces distinct ids', () => {
    const ids = new Set(Array.from({ length: 20 }, () => makeTemplateId()))
    expect(ids.size).toBe(20)
  })
})

describe('insertTemplate', () => {
  it('into empty text: a plain assignment, no leading blank line', () => {
    expect(insertTemplate('', 0, 'Add tests.')).toEqual({ text: 'Add tests.', caret: 'Add tests.'.length })
  })

  it('appended at the end of existing text: separated by a blank line', () => {
    const result = insertTemplate('Fix the bug.', 'Fix the bug.'.length, 'Add tests.')
    expect(result.text).toBe('Fix the bug.\n\nAdd tests.')
    expect(result.caret).toBe(result.text.length)
  })

  it('already ending in one newline: only one more is added (still a blank line total)', () => {
    const result = insertTemplate('Fix the bug.\n', 'Fix the bug.\n'.length, 'Add tests.')
    expect(result.text).toBe('Fix the bug.\n\nAdd tests.')
  })

  it('already ending in a blank line: no extra separator is added', () => {
    const result = insertTemplate('Fix the bug.\n\n', 'Fix the bug.\n\n'.length, 'Add tests.')
    expect(result.text).toBe('Fix the bug.\n\nAdd tests.')
  })

  it('inserts mid-text separated on BOTH sides, keeping the tail intact', () => {
    const text = 'BeforeAfter'
    const caret = 'Before'.length
    const result = insertTemplate(text, caret, 'MID')
    // Not 'Before\n\nMIDAfter': the tail needs a separator too, or the snippet runs straight
    // into the sentence the caret was parked in.
    expect(result.text).toBe('Before\n\nMID\n\nAfter')
    // The caret lands right after the snippet — the trailing separator belongs to the tail.
    expect(result.caret).toBe('Before\n\nMID'.length)
  })

  it('clamps an out-of-range caret instead of throwing', () => {
    expect(insertTemplate('hi', 999, 'x').text).toBe('hi\n\nx')
    // Clamped to 0: "before" is empty, so no separator is prepended (same rule as the
    // empty-text case above) — but the tail still gets one.
    expect(insertTemplate('hi', -5, 'x').text).toBe('x\n\nhi')
  })

  // The caret can be anywhere in the box when a template is picked; every position must come out
  // cleanly separated on both sides, with no doubled blank lines and no trailing whitespace.
  describe('separates cleanly at any caret position', () => {
    const cases: { name: string; text: string; caret: number; expected: string }[] = [
      { name: 'empty text', text: '', caret: 0, expected: 'SNIP' },
      { name: 'start of text', text: 'Fix the bug', caret: 0, expected: 'SNIP\n\nFix the bug' },
      // The space that separated "Fix" from "the bug" is dropped, not carried onto the new line
      // as indentation (the #413 review's nit).
      { name: 'middle of a word', text: 'Fix the bug', caret: 3, expected: 'Fix\n\nSNIP\n\nthe bug' },
      { name: 'end of text', text: 'Fix the bug', caret: 11, expected: 'Fix the bug\n\nSNIP' },
      {
        name: 'existing blank line on both sides',
        text: 'One.\n\nTwo.',
        caret: 'One.\n\n'.length,
        expected: 'One.\n\nSNIP\n\nTwo.',
      },
      {
        name: 'single newline on both sides',
        text: 'One.\nTwo.',
        caret: 'One.'.length,
        expected: 'One.\n\nSNIP\n\nTwo.',
      },
      {
        name: 'blank line before, nothing after (caret at end of a padded box)',
        text: 'One.\n\n',
        caret: 'One.\n\n'.length,
        expected: 'One.\n\nSNIP',
      },
    ]

    for (const { name, text, caret, expected } of cases) {
      it(name, () => {
        const result = insertTemplate(text, caret, 'SNIP')
        expect(result.text).toBe(expected)
        expect(result.text).not.toMatch(/\n{3}/)
        expect(result.text).toBe(result.text.trimEnd())
        // The caret always sits immediately after the snippet the user just inserted.
        expect(result.text.slice(result.caret - 'SNIP'.length, result.caret)).toBe('SNIP')
      })
    }
  })

  it('is idempotent about separators — stacking templates never doubles the blank line', () => {
    const first = insertTemplate('', 0, 'One.')
    const second = insertTemplate(first.text, first.caret, 'Two.')
    const third = insertTemplate(second.text, second.caret, 'Three.')
    expect(third.text).toBe('One.\n\nTwo.\n\nThree.')
  })

  // The #413 review's nit — and the trap in fixing it. A bare `trimStart()` on the tail also eats
  // a leading NEWLINE, which is exactly the character that makes the blank line.
  it('drops the space the caret split, but never a newline the separator still needs', () => {
    expect(insertTemplate('ALPHA OMEGA', 5, 'SNIP').text).toBe('ALPHA\n\nSNIP\n\nOMEGA')
    expect(insertTemplate('One.\nTwo.', 4, 'SNIP').text).toBe('One.\n\nSNIP\n\nTwo.')
    expect(insertTemplate('One.\n\nTwo.', 6, 'SNIP').text).toBe('One.\n\nSNIP\n\nTwo.')
  })

  it('a tail of nothing but spaces leaves no trailing whitespace behind', () => {
    expect(insertTemplate('Fix.   ', 4, 'SNIP').text).toBe('Fix.\n\nSNIP')
  })
})

// ---- skill assignment + auto-apply (#413 follow-up) ---------------------------------------------

const ADD_TESTS: PromptTemplate = { id: 'a', label: 'A', text: 'Add tests.', skills: ['om-fix'] }
const BE_TERSE: PromptTemplate = { id: 'b', label: 'B', text: 'Be terse.', skills: ['om-fix', 'om-review'] }
const MANUAL: PromptTemplate = { id: 'c', label: 'C', text: 'Manual only.' }
const LIST = [ADD_TESTS, BE_TERSE, MANUAL]

describe('normalizePromptTemplates — assigned skills', () => {
  it('keeps a valid assignment', () => {
    expect(normalizePromptTemplates([ADD_TESTS])).toEqual([ADD_TESTS])
  })

  it('omits the key rather than emitting [] — so an old ui-state.json round-trips unchanged', () => {
    expect(normalizePromptTemplates([{ id: 'a', label: 'A', text: 'T.', skills: [] }])).toEqual([
      { id: 'a', label: 'A', text: 'T.' },
    ])
    expect(normalizePromptTemplates([{ id: 'a', label: 'A', text: 'T.' }])[0]).not.toHaveProperty('skills')
  })

  it('garbage in skills degrades to no assignment — it never throws or bricks the template', () => {
    const cases = ['nope', 42, {}, null, [null, 7, {}]]
    for (const skills of cases) {
      expect(normalizePromptTemplates([{ id: 'a', label: 'A', text: 'T.', skills }])).toEqual([
        { id: 'a', label: 'A', text: 'T.' },
      ])
    }
  })

  it('trims and dedupes assigned names', () => {
    expect(
      normalizePromptTemplates([{ id: 'a', label: 'A', text: 'T.', skills: ['  om-fix ', 'om-fix', ''] }]),
    ).toEqual([{ id: 'a', label: 'A', text: 'T.', skills: ['om-fix'] }])
  })
})

describe('templatesForSkills', () => {
  it('no selection assigns nothing', () => {
    expect(templatesForSkills(LIST, [])).toEqual([])
  })

  it('picks the templates assigned to the selected skill, unassigned ones never self-apply', () => {
    expect(templatesForSkills(LIST, ['om-review'])).toEqual([BE_TERSE])
    expect(templatesForSkills(LIST, ['om-fix'])).toEqual([ADD_TESTS, BE_TERSE])
  })

  it('a skill with nothing assigned to it matches nothing', () => {
    expect(templatesForSkills(LIST, ['om-unrelated'])).toEqual([])
  })

  it('a multi-skill selection stacks in LIST order, not selection order — and never twice', () => {
    expect(templatesForSkills(LIST, ['om-review', 'om-fix'])).toEqual([ADD_TESTS, BE_TERSE])
  })
})

describe('autoApplyText', () => {
  it('joins the assigned templates with the same blank line insertTemplate uses', () => {
    expect(autoApplyText(LIST, ['om-fix'])).toBe('Add tests.\n\nBe terse.')
  })

  it('nothing assigned is the empty string — "auto-apply contributes nothing"', () => {
    expect(autoApplyText(LIST, [])).toBe('')
    expect(autoApplyText(LIST, ['om-unrelated'])).toBe('')
  })
})

describe('resolveAutoApply', () => {
  it('fills an empty box', () => {
    expect(resolveAutoApply('', '', 'AUTO')).toEqual({ text: 'AUTO', applied: 'AUTO' })
  })

  it('NEVER overwrites what the user typed — the whole point of the rule', () => {
    expect(resolveAutoApply('my own words', '', 'AUTO')).toEqual({ text: 'my own words', applied: '' })
  })

  it('replaces its own previous text when the selection changes', () => {
    expect(resolveAutoApply('AUTO', 'AUTO', 'NEXT')).toEqual({ text: 'NEXT', applied: 'NEXT' })
  })

  it('deselecting takes the auto-applied text back out again', () => {
    expect(resolveAutoApply('AUTO', 'AUTO', '')).toEqual({ text: '', applied: '' })
  })

  it('a user edit to auto-applied text makes it theirs — later changes leave it alone', () => {
    const edited = resolveAutoApply('AUTO plus my note', 'AUTO', 'NEXT')
    expect(edited).toEqual({ text: 'AUTO plus my note', applied: 'AUTO' })
    // …and it keeps standing its ground on every subsequent change.
    expect(resolveAutoApply(edited.text, edited.applied, 'THIRD')).toEqual({
      text: 'AUTO plus my note',
      applied: 'AUTO',
    })
  })

  it('clearing the box by hand opts back in — no mode the user can get stuck in', () => {
    const typed = resolveAutoApply('mine', '', 'AUTO')
    expect(typed.text).toBe('mine')
    expect(resolveAutoApply('', typed.applied, 'AUTO')).toEqual({ text: 'AUTO', applied: 'AUTO' })
  })

  // `base` — the GitHub hand-off's pre-filled item reference (#524).
  describe('with a pre-filled base', () => {
    it('stacks auto-applied text BELOW the base instead of wiping it', () => {
      expect(resolveAutoApply('BASE', '', 'AUTO', 'BASE')).toEqual({
        text: 'BASE\n\nAUTO',
        applied: 'BASE\n\nAUTO',
      })
    })

    it('deselecting returns to the bare base, not to an empty box', () => {
      expect(resolveAutoApply('BASE\n\nAUTO', 'BASE\n\nAUTO', '', 'BASE')).toEqual({
        text: 'BASE',
        applied: '',
      })
    })

    it('a user edit is still never overwritten', () => {
      expect(resolveAutoApply('BASE\n\nmine', '', 'AUTO', 'BASE')).toEqual({
        text: 'BASE\n\nmine',
        applied: '',
      })
    })

    it('clearing the box by hand STILL opts back in — the base must not trap it', () => {
      // `applied` reports only genuinely auto-applied text, never the bare base; otherwise an
      // emptied box would match neither `base` nor `previousAuto` and auto-apply would be dead
      // for that item forever.
      const mounted = resolveAutoApply('BASE', '', '', 'BASE')
      expect(mounted).toEqual({ text: 'BASE', applied: '' })
      expect(resolveAutoApply('', mounted.applied, 'AUTO', 'BASE')).toEqual({
        text: 'BASE\n\nAUTO',
        applied: 'BASE\n\nAUTO',
      })
    })

    it('no base is byte-identical to the three-argument rule', () => {
      expect(resolveAutoApply('', '', 'AUTO', '')).toEqual(resolveAutoApply('', '', 'AUTO'))
      expect(resolveAutoApply('mine', '', 'AUTO', '')).toEqual(resolveAutoApply('mine', '', 'AUTO'))
    })
  })
})
