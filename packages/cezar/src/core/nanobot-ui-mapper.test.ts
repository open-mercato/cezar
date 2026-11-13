import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NanobotEventMapper } from './nanobot-ui-mapper.ts';

describe('native Nanobot bridge golden transcript', () => {
  it('preserves the source-derived wire capabilities without guessed events', () => {
    const base = new URL('./__fixtures__/nanobot/native-turn', import.meta.url);
    const mapper = new NanobotEventMapper();
    const actual = readFileSync(`${base.pathname}.ndjson`, 'utf8').trim().split('\n')
      .flatMap((line) => mapper.map(JSON.parse(line)).ui);
    expect(actual).toEqual(JSON.parse(readFileSync(`${base.pathname}.expected.json`, 'utf8')));
  });
});
