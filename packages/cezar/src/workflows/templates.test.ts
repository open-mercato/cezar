import { describe, expect, it } from 'vitest';
import { splitQuestionText } from '@open-mercato/cezar-contract';
import { BUILT_IN_GRAPH_WORKFLOWS, REVIEW_COUNCIL } from './templates.ts';

/** Every gate and ask text the built-ins put on a card. */
const cardTexts = BUILT_IN_GRAPH_WORKFLOWS.flatMap((workflow) =>
  (workflow.graph?.nodes ?? []).flatMap((node) =>
    node.type === 'gate.human' ? [[`${workflow.name}/${node.id}`, node.message] as const]
      : node.type === 'ask-user' ? [[`${workflow.name}/${node.id}`, node.question] as const]
        : []));

describe('built-in card texts (#2477)', () => {
  it('has gate texts to check', () => {
    expect(cardTexts.length).toBeGreaterThan(0);
  });

  // An agent's free text may hold a `---` line, which would fold the question below it out of sight.
  it.each(cardTexts)('%s asks its question before any agent output', (_name, text) => {
    const { main } = splitQuestionText(text);
    expect(main.trimEnd().endsWith('?')).toBe(true);
    const outputs = [...main.matchAll(/\{\{nodes\.[^.}]+\.([^}]+)\}\}/g)].map((match) => match[1]);
    // A verdict is one word from the node's own `verdicts` list.
    expect(outputs.filter((output) => output !== 'verdict')).toEqual([]);
  });

  it('folds the council summary under Details, below its question', () => {
    const gate = REVIEW_COUNCIL.graph?.nodes.find((node) => node.id === 'gate');
    expect(gate?.type === 'gate.human' && splitQuestionText(gate.message)).toEqual({
      main: 'Council verdict: {{nodes.judge.verdict}}. Open a PR for “{{task}}”?',
      details: '{{nodes.judge.summary}}',
    });
  });
});
