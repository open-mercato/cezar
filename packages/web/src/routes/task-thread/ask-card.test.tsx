import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/client'
import { questionKeys, resetDismissals } from '@/api/questions'
import { deriveAttention } from '@/lib/attention'
import { AskCard, AskForm, latestOpenAskCard, revealAskCard } from './ask-card'
import { readAskSelections, resetAskSelections } from './ask-selections'
import type { ThreadAsk } from './thread-state'
import type { ApiRun, ProviderStatusResponse, StepState } from '@open-mercato/cezar-api-client'

const mutateAsync = vi.fn().mockResolvedValue({})
const continueAsync = vi.fn().mockResolvedValue({})
let providerStatus: ProviderStatusResponse
vi.mock('@/api/queries', () => ({
  useSendMessage: () => ({ mutateAsync, isPending: false }),
  useContinueRun: () => ({ mutateAsync: continueAsync, isPending: false }),
  useProviderStatus: () => ({ data: providerStatus, isSuccess: true }),
}))

afterEach(() => {
  cleanup()
  resetAskSelections()
  resetDismissals()
  mutateAsync.mockClear().mockResolvedValue({})
  continueAsync.mockClear().mockResolvedValue({})
  providerStatus = {
    providers: [
      { provider: 'claude', status: 'connected', enabled: true },
      { provider: 'codex', status: 'not-installed', enabled: true },
      { provider: 'opencode', status: 'not-installed', enabled: true },
      { provider: 'cursor', status: 'not-installed', enabled: true },
    ],
  }
})

const activeRun: ApiRun = {
  id: 'r1',
  title: 'Task',
  workflow: 'quick-task',
  task: 'Task',
  status: 'waiting',
  createdAt: '2026-07-24T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  runner: 'claude',
  steps: [],
}

const step = (extra: Partial<StepState> = {}): StepState => ({
  id: 'task',
  name: 'Do the task',
  kind: 'agent',
  status: 'done',
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

/** The run the feature exists for: the session closed while the question was unanswered. */
const closedRun: ApiRun = {
  ...activeRun,
  status: 'done',
  steps: [step({ sessionId: 'sess-1' })],
}

let queryClient = new QueryClient()
const wrap = (node: ReactNode, entry = '/') => (
  <QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={[entry]}>{node}</MemoryRouter>
  </QueryClientProvider>
)
const renderAsk = (ask: ThreadAsk, run: ApiRun = activeRun, entry?: string) => {
  queryClient = new QueryClient()
  return render(wrap(<AskCard ask={ask} run={run} />, entry))
}

const singleAsk: ThreadAsk = {
  kind: 'ask',
  id: 'ask_1',
  resolved: false,
  questions: [
    {
      header: 'Library',
      question: 'Which date library should I standardize on?',
      options: [
        { label: 'date-fns', description: 'Tree-shakeable' },
        { label: 'Luxon', description: 'Immutable, tz-aware' },
      ],
    },
  ],
}

const multiAsk: ThreadAsk = {
  kind: 'ask',
  id: 'ask_2',
  resolved: false,
  questions: [
    {
      header: 'Sections',
      question: 'Which settings sections?',
      multiSelect: true,
      options: [{ label: 'Profile' }, { label: 'Appearance' }, { label: 'Billing' }],
    },
  ],
}

const twoQuestionAsk: ThreadAsk = {
  kind: 'ask',
  id: 'ask_3',
  resolved: false,
  questions: [
    {
      header: 'Library',
      question: 'Which library?',
      options: [{ label: 'date-fns' }, { label: 'Luxon' }],
    },
    {
      header: 'Style',
      question: 'Which style?',
      options: [{ label: 'ISO' }, { label: 'Relative' }],
    },
  ],
}

describe('AskCard — who asks', () => {
  it('names the agent by default and the workflow for a graph gate/question', () => {
    const { unmount } = renderAsk(singleAsk)
    expect(screen.getByText('The agent is asking')).toBeTruthy()
    unmount()
    renderAsk({ ...singleAsk, fromWorkflow: true })
    expect(screen.getByText('The workflow is asking')).toBeTruthy()
  })
})

describe('AskCard', () => {
  it('renders the header, question and each option with its description', () => {
    renderAsk(singleAsk)
    expect(screen.getByText('Library')).toBeTruthy()
    expect(screen.getByText('Which date library should I standardize on?')).toBeTruthy()
    expect(screen.getByRole('button', { name: /date-fns/ })).toBeTruthy()
    expect(screen.getByText('Tree-shakeable')).toBeTruthy()
  })

  it('wraps schema-valid unbroken question and option text inside the card', () => {
    const question = 'q'.repeat(400)
    const label = 'l'.repeat(60)
    const description = 'd'.repeat(280)
    renderAsk({
      ...singleAsk,
      questions: [{ header: 'Limits', question, options: [{ label, description }, { label: 'Other' }] }],
    })

    expect(screen.getByText(question).className).toContain('break-words')
    expect(screen.getByText(label).className).toContain('break-words')
    expect(screen.getByText(description).className).toContain('break-words')
  })

  it('a single single-select question sends "header: label" on one tap (no Send button), naming its card', () => {
    renderAsk(singleAsk)
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    // askRequestId closes exactly this card server-side; a composer reply sends none (Questions inbox).
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: date-fns', askRequestId: 'ask_1' })
  })

  it('gives Other… and Need more info a 44 px target on a touch screen', () => {
    renderAsk(singleAsk)
    for (const name of ['Other…', 'Need more info']) {
      const chip = screen.getByRole('button', { name })
      expect(chip.className).toContain('pointer-coarse:min-h-11')
      expect(chip.className).not.toContain('pointer-coarse:min-h-10')
    }
  })

  it('multiple questions: one Send posts every answer in one combined message', () => {
    renderAsk(twoQuestionAsk)
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    // A thumb-sized target on a touch screen, unchanged under a mouse.
    expect(send.className).toContain('pointer-coarse:min-h-11')
    // Answering only the first question does NOT send, and does not resolve.
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    expect(send.disabled).toBe(true)
    expect(mutateAsync).not.toHaveBeenCalled()
    // Both answered → one combined message.
    fireEvent.click(screen.getByRole('button', { name: /Relative/ }))
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(mutateAsync).toHaveBeenCalledTimes(1)
    expect(mutateAsync).toHaveBeenCalledWith({ askRequestId: expect.any(String), text: 'Library: date-fns\nStyle: Relative' })
  })

  it('multi-select: Send is disabled until options are picked, then sends the comma-joined labels', () => {
    renderAsk(multiAsk)
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Profile/ }))
    fireEvent.click(screen.getByRole('button', { name: /Billing/ }))
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(mutateAsync).toHaveBeenCalledWith({ askRequestId: expect.any(String), text: 'Sections: Profile, Billing' })
  })

  it('a resolved ask collapses to answer chips with no option buttons', () => {
    renderAsk({ ...singleAsk, resolved: true, answer: 'Library: date-fns' })
    expect(screen.getByText('Answered')).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    const chips = [...document.querySelectorAll('[data-slot="ask-answers"] [data-slot="chip"]')]
    expect(chips.map((chip) => [chip.textContent, chip.getAttribute('data-active')])).toEqual([
      ['date-fns (chosen)', 'true'],
      ['Luxon', null],
    ])
    // The chosen option keeps its description; the others keep theirs as a tooltip.
    expect(document.querySelector('[data-slot="ask-answer-description"]')?.textContent).toBe('Tree-shakeable')
    expect(chips[1]?.getAttribute('title')).toBe('Immutable, tz-aware')
  })

  it('a resolved ask in the user\'s own words stays prose', () => {
    renderAsk({ ...singleAsk, resolved: true, answer: 'whichever is smaller' })
    expect(screen.getByText('whichever is smaller').className).toContain('break-words')
    expect(document.querySelector('[data-slot="chip"]')).toBeNull()
  })

  it.each([
    ['disabled', { provider: 'claude', status: 'connected', enabled: false }, 'Claude Code is disabled. Enable it in Settings → Agents → Providers.'],
    ['disconnected', { provider: 'claude', status: 'disconnected', enabled: true }, 'Claude Code credentials are unavailable. Authorize it in Settings → Agents → Providers.'],
  ] as const)('disables Ask submissions when its active provider is %s', (_case, claude, reason) => {
    providerStatus = {
      providers: [
        claude,
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
        { provider: 'cursor', status: 'not-installed', enabled: true },
      ],
    }

    renderAsk(singleAsk)

    expect((screen.getByRole('button', { name: /date-fns/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(reason)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Configure providers' }).getAttribute('href')).toBe(
      '/settings/agents#providers',
    )
    expect(mutateAsync).not.toHaveBeenCalled()
  })
})

// #1247: the card is a thread row, and a virtualized thread unmounts every row that scrolls out
// of view. The picks lived in component state and died with it, leaving Send disabled with
// nothing on screen to say why.
describe('AskCard — picks survive the row unmounting', () => {
  it('keeps picks across an unmount and remount of the card', () => {
    const first = renderAsk(twoQuestionAsk)
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    fireEvent.click(screen.getByRole('button', { name: /ISO/ }))
    first.unmount()

    renderAsk(twoQuestionAsk)
    expect(screen.getByRole('button', { name: /date-fns/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /ISO/ }).getAttribute('aria-pressed')).toBe('true')
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(mutateAsync).toHaveBeenCalledWith({ askRequestId: expect.any(String), text: 'Library: date-fns\nStyle: ISO' })
  })

  it('never carries picks to another run or another ask', () => {
    const first = renderAsk(twoQuestionAsk)
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    first.unmount()

    const other = renderAsk(twoQuestionAsk, { ...activeRun, id: 'r2' })
    expect(screen.getByRole('button', { name: /date-fns/ }).getAttribute('aria-pressed')).toBe('false')
    other.unmount()
    renderAsk({ ...twoQuestionAsk, id: 'ask_4' })
    expect(screen.getByRole('button', { name: /date-fns/ }).getAttribute('aria-pressed')).toBe('false')
  })

  it('drops the held picks once the ask resolves', () => {
    const { rerender } = renderAsk(twoQuestionAsk)
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    expect(readAskSelections('r1', twoQuestionAsk)).toEqual({ 0: { labels: ['date-fns'] } })

    rerender(wrap(<AskCard ask={{ ...twoQuestionAsk, resolved: true, answer: 'free-form reply' }} run={activeRun} />))
    expect(readAskSelections('r1', twoQuestionAsk)).toEqual({})
  })

  // Codex names asks `codex-<rpc id>`, a counter that restarts with its app-server, so a
  // Continue can reuse an id within one run for a different question.
  it('a reused ask id with different questions neither inherits nor wipes the old picks', () => {
    const first = renderAsk(twoQuestionAsk)
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    first.unmount()

    const reused: ThreadAsk = {
      ...twoQuestionAsk,
      questions: [
        { header: 'Host', question: 'Which host?', options: [{ label: 'date-fns' }, { label: 'Fly' }] },
        { header: 'Region', question: 'Which region?', options: [{ label: 'EU' }, { label: 'US' }] },
      ],
    }
    renderAsk(reused)
    expect(screen.getByRole('button', { name: /date-fns/ }).getAttribute('aria-pressed')).toBe('false')
    cleanup()
    renderAsk({ ...reused, resolved: true, answer: 'Host: Fly' })
    expect(readAskSelections('r1', twoQuestionAsk)).toEqual({ 0: { labels: ['date-fns'] } })
  })

  it('a half-answered card names the questions still missing a pick', () => {
    renderAsk(twoQuestionAsk, closedRun)
    // A fresh card names nothing — every header would be noise.
    expect(document.querySelector('[data-slot="ask-unanswered"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    expect(document.querySelector('[data-slot="ask-unanswered"]')?.textContent).toBe('unanswered: Style')
    fireEvent.click(screen.getByRole('button', { name: /Relative/ }))
    expect(document.querySelector('[data-slot="ask-unanswered"]')).toBeNull()
  })
})

// The question outlives its session: an idle timeout, a cezar restart, Finish or a cancel
// closes the session with the card still unanswered. Before this, every tap posted to
// `POST /messages` and died on its `409 session closed` — silently.
describe('AskCard — answering after the session has ended', () => {
  it('a closed run resumes instead of replying, with the same answer text', async () => {
    renderAsk(singleAsk, closedRun)
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    await waitFor(() => expect(continueAsync).toHaveBeenCalledTimes(1))
    // No runner override: answering a question must not silently switch the run's engine. The
    // reopened session still answers exactly this card (Questions inbox).
    expect(continueAsync).toHaveBeenCalledWith({ text: 'Library: date-fns', askRequestId: 'ask_1' })
    expect(mutateAsync).not.toHaveBeenCalled()
  })

  it('says the session reopens, on both the one-tap and the combined-Send shapes', () => {
    const { unmount } = renderAsk(singleAsk, closedRun)
    expect(screen.getByText('The session has ended — your answer reopens it and goes to the agent.')).toBeTruthy()
    unmount()
    renderAsk(twoQuestionAsk, closedRun)
    expect(screen.getByRole('button', { name: 'Send answer & reopen' })).toBeTruthy()
    expect(screen.getByText('the session has ended — sending reopens it')).toBeTruthy()
  })

  // The resume affordance must be identifiable without reading copy — and must NOT be claimed
  // by a live run's ordinary "pick one or more" hint, which sits in the same slot position.
  it('marks the delivery seam on the card, and only names the resume hint when resuming', () => {
    const { unmount } = renderAsk(twoQuestionAsk, activeRun)
    expect(document.querySelector('[data-slot="ask-card"]')?.getAttribute('data-delivery')).toBe('live')
    expect(document.querySelector('[data-slot="ask-resume-hint"]')).toBeNull()
    expect(document.querySelector('[data-slot="ask-hint"]')).toBeTruthy()
    unmount()
    renderAsk(twoQuestionAsk, closedRun)
    expect(document.querySelector('[data-slot="ask-card"]')?.getAttribute('data-delivery')).toBe('resume')
    expect(document.querySelector('[data-slot="ask-resume-hint"]')).toBeTruthy()
  })

  it('combined Send on a closed run resumes once with every answer', async () => {
    renderAsk(twoQuestionAsk, closedRun)
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    fireEvent.click(screen.getByRole('button', { name: /Relative/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Send answer & reopen' }))
    await waitFor(() => expect(continueAsync).toHaveBeenCalledTimes(1))
    expect(continueAsync).toHaveBeenCalledWith({
      text: 'Library: date-fns\nStyle: Relative',
      askRequestId: expect.any(String),
    })
  })

  it('a stale record that still claims a live session falls back to a resume on 409', async () => {
    // The cockpit's cached record says `waiting`; the server has already closed the session.
    mutateAsync.mockRejectedValueOnce(new ApiError(409, 'session closed'))
    renderAsk(singleAsk, { ...activeRun, steps: [step({ sessionId: 'sess-1' })] })
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    await waitFor(() => expect(continueAsync).toHaveBeenCalledTimes(1))
    expect(continueAsync).toHaveBeenCalledWith({ text: 'Library: date-fns', askRequestId: 'ask_1' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('waits for idle teardown before retrying the continuation, without accepting a duplicate tap', async () => {
    mutateAsync.mockRejectedValueOnce(new ApiError(409, 'session closed'))
    let resolveContinuation: ((value: { continued: true }) => void) | undefined
    const continuation = new Promise<{ continued: true }>((resolve) => {
      resolveContinuation = resolve
    })
    continueAsync
      .mockRejectedValueOnce(new ApiError(409, 'run is still active'))
      .mockReturnValueOnce(continuation)
    renderAsk(singleAsk, { ...activeRun, steps: [step({ sessionId: 'sess-1' })] })

    const option = screen.getByRole('button', { name: /date-fns/ })
    fireEvent.click(option)
    await waitFor(() => expect(continueAsync).toHaveBeenCalledTimes(1))
    expect((option as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(option)

    await waitFor(() => expect(continueAsync).toHaveBeenCalledTimes(2))
    expect(continueAsync).toHaveBeenNthCalledWith(1, { text: 'Library: date-fns', askRequestId: 'ask_1' })
    expect(continueAsync).toHaveBeenNthCalledWith(2, { text: 'Library: date-fns', askRequestId: 'ask_1' })
    expect(mutateAsync).toHaveBeenCalledTimes(1)
    resolveContinuation?.({ continued: true })
    await waitFor(() => expect((option as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not silently switch to another connected provider when the run provider is unavailable', () => {
    providerStatus = {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
        { provider: 'cursor', status: 'not-installed', enabled: true },
      ],
    }

    renderAsk(singleAsk, closedRun)

    expect((screen.getByRole('button', { name: /date-fns/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(
      screen.getByText(
        'Claude Code credentials are unavailable. Authorize it in Settings → Agents → Providers.',
      ),
    ).toBeTruthy()
    expect(continueAsync).not.toHaveBeenCalled()
  })

  it('a refused delivery is shown on the card instead of being dropped', async () => {
    continueAsync.mockRejectedValueOnce(new ApiError(409, 'no agent session to resume'))
    renderAsk(singleAsk, closedRun)
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    expect((await screen.findByRole('alert')).textContent).toBe('no agent session to resume')
  })

  it('a closed run that never recorded a session says so and stays inert', () => {
    renderAsk(singleAsk, { ...closedRun, steps: [step()] })
    expect((screen.getByRole('button', { name: /date-fns/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(
      screen.getByText(
        'This session has ended and no agent session was recorded, so the answer cannot be delivered.',
      ),
    ).toBeTruthy()
    expect(mutateAsync).not.toHaveBeenCalled()
    expect(continueAsync).not.toHaveBeenCalled()
  })
})

// The user's own answer and "I need more context" — both alongside the agent's options.
describe('AskCard — Other… and Need more info', () => {
  const otherButton = () => screen.getByRole('button', { name: 'Other…' })
  const moreInfoButton = () => screen.getByRole('button', { name: 'Need more info' })
  const ownAnswer = () => screen.getByRole('textbox', { name: /Your own answer/ }) as HTMLTextAreaElement

  it('one-tap card: Other… opens a field whose Send posts the typed text, on one line', () => {
    renderAsk(singleAsk)
    fireEvent.click(otherButton())
    expect(mutateAsync).not.toHaveBeenCalled()
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(ownAnswer(), { target: { value: '  Temporal,\nonce it ships  ' } })
    fireEvent.click(send)
    expect(mutateAsync).toHaveBeenCalledWith({ askRequestId: expect.any(String), text: 'Library: Temporal, once it ships' })
  })

  it('one-tap card: Enter in the field sends, Shift+Enter does not', () => {
    renderAsk(singleAsk)
    fireEvent.click(otherButton())
    fireEvent.change(ownAnswer(), { target: { value: 'Day.js' } })
    fireEvent.keyDown(ownAnswer(), { key: 'Enter', shiftKey: true })
    expect(mutateAsync).not.toHaveBeenCalled()
    fireEvent.keyDown(ownAnswer(), { key: 'Enter' })
    expect(mutateAsync).toHaveBeenCalledWith({ askRequestId: expect.any(String), text: 'Library: Day.js' })
  })

  it('one-tap card: Need more info sends the request at once', () => {
    renderAsk(singleAsk)
    fireEvent.click(moreInfoButton())
    expect(mutateAsync).toHaveBeenCalledWith({
      askRequestId: expect.any(String),
      text: 'Library: I need more information to answer this — please explain the context and ask again.',
    })
  })

  it('multi-question card: each question can be answered by own text or Need more info', () => {
    renderAsk(twoQuestionAsk)
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    const [libraryOther] = screen.getAllByRole('button', { name: 'Other…' })
    const [, styleMoreInfo] = screen.getAllByRole('button', { name: 'Need more info' })

    fireEvent.click(libraryOther!)
    // An open but empty field is not an answer.
    expect(send.disabled).toBe(true)
    fireEvent.change(ownAnswer(), { target: { value: 'Temporal' } })
    fireEvent.click(styleMoreInfo!)
    expect(styleMoreInfo!.getAttribute('aria-pressed')).toBe('true')
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(mutateAsync).toHaveBeenCalledTimes(1)
    expect(mutateAsync).toHaveBeenCalledWith({
      askRequestId: expect.any(String),
      text:
        'Library: Temporal\n' +
        'Style: I need more information to answer this — please explain the context and ask again.',
    })
  })

  it('single-select: a pick, own text and Need more info replace one another', () => {
    renderAsk(twoQuestionAsk)
    const [libraryOther] = screen.getAllByRole('button', { name: 'Other…' })
    const [libraryMoreInfo] = screen.getAllByRole('button', { name: 'Need more info' })
    const dateFns = screen.getByRole('button', { name: /date-fns/ })

    fireEvent.click(dateFns)
    fireEvent.click(libraryOther!)
    expect(dateFns.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(libraryMoreInfo!)
    expect(libraryOther!.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(dateFns)
    expect(libraryMoreInfo!.getAttribute('aria-pressed')).toBe('false')
    expect(readAskSelections('r1', twoQuestionAsk)).toEqual({ 0: { labels: ['date-fns'] } })
  })

  it('multi-select: own text joins the picked options', () => {
    renderAsk(multiAsk)
    fireEvent.click(screen.getByRole('button', { name: /Profile/ }))
    fireEvent.click(otherButton())
    fireEvent.change(ownAnswer(), { target: { value: 'Notifications' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    expect(mutateAsync).toHaveBeenCalledWith({ askRequestId: expect.any(String), text: 'Sections: Profile, Notifications' })
  })

  it('keeps the typed text across an unmount and remount of the card', () => {
    const first = renderAsk(twoQuestionAsk)
    fireEvent.click(screen.getAllByRole('button', { name: 'Other…' })[0]!)
    fireEvent.change(ownAnswer(), { target: { value: 'Temporal' } })
    first.unmount()

    renderAsk(twoQuestionAsk)
    expect(ownAnswer().value).toBe('Temporal')
  })
})

describe('AskCard — Other… focus', () => {
  it('focuses the field when opened, but not when an open field remounts', () => {
    const first = renderAsk(twoQuestionAsk)
    fireEvent.click(screen.getAllByRole('button', { name: 'Other…' })[0]!)
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
    first.unmount()

    renderAsk(twoQuestionAsk)
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(document.activeElement).not.toBe(screen.getByRole('textbox'))
  })
})

describe('AskForm — phones, screen readers and a pending send', () => {
  const ownAnswer = () => screen.getByRole('textbox', { name: /Your own answer/ }) as HTMLTextAreaElement

  it('on a phone, Enter in Other… is a newline and only Send answer sends', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      media: query,
      matches: query === '(pointer: coarse) and (hover: none)',
      addEventListener() {},
      removeEventListener() {},
    }))
    try {
      renderAsk(singleAsk)
      fireEvent.click(screen.getByRole('button', { name: 'Other…' }))
      expect(ownAnswer().getAttribute('enterkeyhint')).toBe('enter')
      fireEvent.change(ownAnswer(), { target: { value: 'Day.js' } })
      expect(fireEvent.keyDown(ownAnswer(), { key: 'Enter' })).toBe(true)
      expect(mutateAsync).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
      expect(mutateAsync).toHaveBeenCalledWith({ askRequestId: expect.any(String), text: 'Library: Day.js' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('an IME commit in Other… never sends', () => {
    renderAsk(singleAsk)
    fireEvent.click(screen.getByRole('button', { name: 'Other…' }))
    fireEvent.change(ownAnswer(), { target: { value: 'にほん' } })
    fireEvent.keyDown(ownAnswer(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(ownAnswer(), { key: 'Enter', keyCode: 229 })
    expect(mutateAsync).not.toHaveBeenCalled()
  })

  it('each question is a group named by its question, multi-select saying so', () => {
    renderAsk(multiAsk)
    expect(screen.getByRole('group', { name: /^Which settings sections\?\s*\(select all that apply\)$/ })).toBeTruthy()
  })

  it('a send in flight says so', () => {
    const delivery = { mode: 'live' as const, isPending: true, send: vi.fn() }
    render(<MemoryRouter><AskForm ask={singleAsk} ownerId="m1" delivery={delivery} asker="Your decision" /></MemoryRouter>)
    expect(screen.getByRole('status').textContent).toBe('Sending…')
    expect(document.querySelector('[data-slot="ask-card"]')?.getAttribute('aria-busy')).toBe('true')
  })

  it('unframed (a manager card, a Questions row) draws no box, no asker and no stray dot, but still says Sending…', () => {
    const delivery = { mode: 'live' as const, isPending: false, send: vi.fn() }
    const { rerender } = render(<MemoryRouter><AskForm ask={singleAsk} ownerId="m1" delivery={delivery} asker="Your decision" framed={false} /></MemoryRouter>)
    const card = document.querySelector<HTMLElement>('[data-slot="ask-card"]')!
    expect(card.className).toBe('')
    expect(card.querySelector('[data-slot="status-dot"]')).toBeNull()
    expect(card.querySelector('[data-slot="ask-asker"]')).toBeNull()
    rerender(<MemoryRouter><AskForm ask={singleAsk} ownerId="m1" delivery={{ ...delivery, isPending: true }} asker="Your decision" framed={false} /></MemoryRouter>)
    expect(screen.getByRole('status').textContent).toBe('Sending…')
    expect(card.querySelector('[data-slot="status-dot"]')).toBeNull()
  })
})

describe('the ask card wears the attention tone for "waiting on a person" (redesign 2026-11)', () => {
  it('its dot and tint are deriveAttention(waiting) — blue, pulsing — never the accent', () => {
    const delivery = { mode: 'live' as const, blockedBy: undefined, reason: undefined, isPending: false, error: undefined, send: vi.fn() }
    render(<MemoryRouter><AskForm ask={singleAsk} ownerId="m1" delivery={delivery} asker="The agent is asking" /></MemoryRouter>)
    const expected = deriveAttention({ status: 'waiting' })
    const card = document.querySelector<HTMLElement>('[data-slot="ask-card"]')!
    expect(card.dataset.tone).toBe(expected.tone)
    expect(card.className).toContain('border-info/30')
    expect(card.className).not.toContain('border-primary')
    const dot = card.querySelector<HTMLElement>('[data-slot="status-dot"]')!
    expect(dot.dataset.tone).toBe(expected.tone)
    expect(dot.className.includes('animate-pulse')).toBe(expected.pulse)
  })
})

describe('latestOpenAskCard / revealAskCard (#2297)', () => {
  const stage = (html: string) => {
    const root = document.createElement('div')
    root.innerHTML = html
    return root
  }

  it('finds the newest unresolved card and skips answered ones', () => {
    const root = stage(
      '<div data-slot="ask-card" data-resolved="false" id="old"></div>' +
        '<div data-slot="ask-card" data-resolved="false" id="new"></div>' +
        '<div data-slot="ask-card" data-resolved="true" id="answered"></div>',
    )
    expect(latestOpenAskCard(root)?.id).toBe('new')
  })

  it('is null when every card is answered or none is mounted', () => {
    expect(latestOpenAskCard(stage('<div data-slot="ask-card" data-resolved="true"></div>'))).toBeNull()
    expect(latestOpenAskCard(stage(''))).toBeNull()
  })

  it('reveal focuses the card\'s first control', () => {
    const root = stage('<div data-slot="ask-card" data-resolved="false"><button>Yes</button><button>No</button></div>')
    document.body.append(root)
    revealAskCard(latestOpenAskCard(root)!)
    expect(document.activeElement?.textContent).toBe('Yes')
    root.remove()
  })
})

// Questions inbox: an `ask.closed` card redraws in the quiet closed state.
describe('AskCard — closed by the server', () => {
  it.each([
    ['replaced', 'Closed: replaced'],
    ['dismissed', 'Closed: dismissed by you'],
    ['retracted', 'Closed: withdrawn by the agent'],
    ['expired', 'Closed: expired'],
    ['ended', 'Closed: task ended'],
  ] as const)('draws a %s card as one quiet line with no chips', (reason, headline) => {
    renderAsk({ ...singleAsk, resolved: true, closed: { reason, detail: reason === 'ended' ? 'The task was cancelled.' : undefined } })
    const closed = document.querySelector('[data-slot="ask-closed"]')!
    expect(closed.querySelector('[data-slot="ask-closed-reason"]')?.textContent).toBe(headline)
    expect(closed.querySelector('s')?.textContent).toBe('Which date library should I standardize on?')
    expect(screen.queryByRole('button', { name: /date-fns/ })).toBeNull()
    if (reason === 'replaced') expect(screen.getByRole('link', { name: 'Go to the newer question ↓' }).getAttribute('href')).toBe('/#ask')
    if (reason === 'ended') expect(closed.textContent).toContain('The task was cancelled.')
  })

  it('an answer from the card keeps the answered summary', () => {
    renderAsk({ ...singleAsk, resolved: true, answer: 'Library: date-fns', closed: { reason: 'answered', answer: 'Library: date-fns' } })
    expect(document.querySelector('[data-slot="ask-closed"]')).toBeNull()
    expect(document.querySelector('[data-slot="ask-card"][data-resolved="true"]')?.textContent).toContain('Answered')
  })

  it('an answer on the manager’s linked copy says where it was answered', () => {
    renderAsk({ ...singleAsk, resolved: true, answer: 'Library: Luxon', closed: { reason: 'answered', answer: 'Library: Luxon', answeredIn: 'manager:global' } })
    const closed = document.querySelector('[data-slot="ask-closed"]')!
    expect(closed.textContent).toContain('Answered in the manager’s chat')
    expect(closed.textContent).toContain('Library: Luxon')
  })
})

// Questions inbox: a typed reply flags a task's card on the run record instead of closing it.
describe('AskCard — may be out of date', () => {
  const staleRun: ApiRun = {
    ...activeRun,
    asks: [{
      requestId: singleAsk.id,
      askedAt: '2026-11-18T08:00:00.000Z',
      questions: singleAsk.questions,
      stale: { why: 'replied-in-chat', detail: 'you replied 4m after it was asked', since: '2026-11-18T08:04:00.000Z' },
    }],
  }

  it('shows the record’s flag above the open card, and Dismiss as out of date starts the undo window', () => {
    renderAsk(singleAsk, staleRun, '/p/alpha/tasks/r1/chat')
    expect(screen.getByText(/May be out of date: you replied 4m after it was asked/)).toBeTruthy()
    expect(document.querySelector('[data-slot="ask-card"][data-resolved="false"]')).not.toBeNull()
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Dismiss as out of date' })))
    expect(screen.getByText('Dismissed «Library»')).toBeTruthy()
  })

  it('prefers the inbox’s key for the card, so the dismissal names the listed question', () => {
    queryClient = new QueryClient()
    const key = 'r:alpha-id:r1:ask_1'
    queryClient.setQueryData(questionKeys.all, {
      open: [{ key, source: { kind: 'task', projectId: 'alpha-id', runId: 'r1', title: 'Task', status: 'waiting' }, askedAt: '2026-11-18T08:00:00.000Z', questions: singleAsk.questions, older: false }],
      closed: [], counts: { live: 1, older: 0 }, olderAfterDays: 7,
    })
    render(wrap(<AskCard ask={singleAsk} run={staleRun} />))
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Dismiss as out of date' })))
    expect(screen.getByText('Dismissed «Library»')).toBeTruthy()
  })

  it('no flag on the record, no note', () => {
    renderAsk(singleAsk, activeRun, '/p/alpha/tasks/r1/chat')
    expect(document.querySelector('[data-slot="question-stale"]')).toBeNull()
  })
})
