import { describe, expect, it } from 'vitest';
import {
  questionCardPartlyReasked,
  questionCardReplaces,
  supersededAskIds,
  type ManagerAsk,
  type ManagerMessage,
} from '@open-mercato/cezar-contract';

/** The one replace rule both managers and tasks use (spec 2026-11-17-questions-inbox, decided 2026-11-18). */
const card = (headers: string[], id?: string): ManagerAsk => ({
  ...(id ? { id } : {}),
  questions: headers.map((header) => ({ header, question: `${header}?`, options: [{ label: 'A' }, { label: 'B' }] })),
});

describe('questionCardReplaces / questionCardPartlyReasked', () => {
  it('the same card name replaces, whatever the headers', () => {
    expect(questionCardReplaces(card(['Renamed'], 'merge-7'), card(['Merge'], 'merge-7'))).toBe(true);
    expect(questionCardPartlyReasked(card(['Renamed'], 'merge-7'), card(['Merge'], 'merge-7'))).toBe(false);
  });

  it('re-asking every header replaces, case and spacing aside', () => {
    expect(questionCardReplaces(card(['base branch', 'Model']), card(['Base  Branch']))).toBe(true);
  });

  it('a partial overlap does not replace; it is partly re-asked', () => {
    expect(questionCardReplaces(card(['Shell']), card(['Shell', 'Base']))).toBe(false);
    expect(questionCardPartlyReasked(card(['Shell']), card(['Shell', 'Base']))).toBe(true);
  });

  it('a named card is replaced only by its name', () => {
    expect(questionCardReplaces(card(['Shell']), card(['Shell'], 'shell'))).toBe(false);
    expect(questionCardReplaces(card(['Shell'], 'other'), card(['Shell'], 'shell'))).toBe(false);
  });

  it('no shared header is neither', () => {
    expect(questionCardPartlyReasked(card(['Model']), card(['Shell']))).toBe(false);
  });
});

describe('supersededAskIds (history before the server closed replaced cards, #2307)', () => {
  let seq = 0;
  const message = (id: string, ask: ManagerAsk, extra: Partial<Extract<ManagerMessage, { kind: 'assistant' }>> = {}): ManagerMessage => ({
    id, seq: seq++, at: 't', kind: 'assistant', turn: 'chat', text: '', streaming: false, commands: [], ask, ...extra,
  });

  it('needs ONE later card to re-ask every header: two partial re-asks together do not supersede', () => {
    const messages = [message('old', card(['Shell', 'Base'])), message('a', card(['Shell'])), message('b', card(['Base']))];
    expect([...supersededAskIds(messages)]).toEqual([]);
  });

  it('a full re-ask or the same name supersedes; answered and closed cards never do', () => {
    const messages = [
      message('full', card(['Shell'])),
      message('named', card(['Design'], 'design')),
      message('answered', card(['Shell']), { askAnswer: 'A' }),
      message('closed', card(['Shell']), { askClosed: { reason: 'dismissed', at: 't' } }),
      message('newest', card(['Shell', 'Other'])),
      message('rename', card(['Layout'], 'design')),
    ];
    expect([...supersededAskIds(messages)].sort()).toEqual(['full', 'named']);
  });
});
