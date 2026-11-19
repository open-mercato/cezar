import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { UiAskQuestion } from '@open-mercato/cezar-api-client'

import { ASK_MORE_INFO_ANSWER, AskAnswerSummary, askAnswerLines, readAskAnswer } from './ask-answer-summary'

const sections: UiAskQuestion = {
  header: 'Sections',
  question: 'Which settings sections?',
  multiSelect: true,
  options: [{ label: 'Yes' }, { label: 'Yes, later' }, { label: 'Billing', description: 'Invoices and plans' }],
}
const host: UiAskQuestion = { header: 'Host', question: 'Which host?', options: [{ label: 'Fly' }, { label: 'Render' }] }

const renderSummary = (questions: UiAskQuestion[], text: string) => {
  const lines = askAnswerLines({ questions }, text)
  if (!lines) throw new Error('not a card answer')
  return render(<AskAnswerSummary questions={questions} lines={lines} slot="ask-answers" />)
}

const chipsOf = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-slot="chip"]')].map((chip) => ({
    text: chip.textContent,
    active: chip.getAttribute('data-active') === 'true',
    answer: chip.getAttribute('data-answer'),
  }))

describe('readAskAnswer', () => {
  it('splits the picks the form joined, longest label first', () => {
    expect(readAskAnswer(sections, 'Yes, later, Billing')).toEqual({ picks: ['Yes, later', 'Billing'] })
    expect(readAskAnswer(sections, 'Yes')).toEqual({ picks: ['Yes'] })
  })

  it('keeps what no option explains as the user\'s own text', () => {
    expect(readAskAnswer(host, 'a VPS of my own')).toEqual({ picks: [], own: 'a VPS of my own' })
    expect(readAskAnswer(sections, 'Billing, and the audit log')).toEqual({ picks: ['Billing'], own: 'and the audit log' })
  })

  it('recognizes "Need more info"', () => {
    expect(readAskAnswer(host, ASK_MORE_INFO_ANSWER)).toEqual({ picks: [], moreInfo: true })
  })
})

describe('AskAnswerSummary', () => {
  it('draws every option as a chip and marks each pick of a multi-select', () => {
    const { container } = renderSummary([sections], 'Sections: Yes, Billing')
    expect(chipsOf(container)).toEqual([
      { text: 'Yes (chosen)', active: true, answer: null },
      { text: 'Yes, later', active: false, answer: null },
      { text: 'Billing (chosen)', active: true, answer: null },
    ])
    expect(screen.getByText('Invoices and plans').getAttribute('data-slot')).toBe('ask-answer-description')
  })

  it('reads an Other answer back as a dashed chip in the active face', () => {
    const { container } = renderSummary([host], 'Host: a VPS of my own')
    const own = container.querySelector('[data-answer="other"]')!
    expect(own.textContent).toBe('Own answer: a VPS of my own')
    expect(own.getAttribute('data-active')).toBe('true')
    expect(own.className).toContain('border-dashed')
    expect(chipsOf(container).filter((chip) => chip.active)).toHaveLength(1)
  })

  it('reads "Need more info" back as its own chip', () => {
    const { container } = renderSummary([host], `Host: ${ASK_MORE_INFO_ANSWER}`)
    expect(container.querySelector('[data-answer="more-info"]')?.textContent).toBe('Need more info (chosen)')
    expect(container.textContent).not.toContain(ASK_MORE_INFO_ANSWER)
  })

  it('wraps on a narrow screen: a chip row wraps and a long chip grows instead of clipping', () => {
    const long = 'a self-hosted VPS behind our own reverse proxy, with the staging box on the same machine'
    const { container } = renderSummary([host], `Host: ${long}`)
    expect(container.querySelector('ul')?.className).toContain('flex-wrap')
    const chip = container.querySelector('[data-answer="other"]')!
    expect(chip.className).toContain('min-h-7')
    expect(chip.className).toContain('break-words')
    expect(chip.className).toContain('max-w-full')
    expect(chip.className).not.toMatch(/(^|\s)h-7(\s|$)/)
  })

  it('names each question once, as a term the screen reader pairs with its answer', () => {
    const { container } = renderSummary([host, sections], 'Host: Fly\nSections: Billing')
    expect([...container.querySelectorAll('dt')].map((term) => term.textContent)).toEqual(['Host:', 'Sections:'])
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })
})
