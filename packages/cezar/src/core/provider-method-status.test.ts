import { describe, expect, it } from 'vitest';
import { openCodeSubscriptionStatus } from './provider-method-status.ts';

function stored(rows: string[], count = rows.length) {
  return ['┌  Credentials /fixture/auth.json', '│', ...rows.map(row => '●  ' + row), '│', '└  ' + count + ' credentials'].join('\n');
}

function openaiJson(...connections: unknown[]) {
  return JSON.stringify([{ id: 'openai', connections }]);
}
const oauth = { type: 'credential', method: 'oauth' };

describe('OpenCode ChatGPT subscription evidence', () => {
  it.each([
    [stored(['\x1b[36mOpenAI\x1b[0m oauth', 'OpenRouter api']), 'connected'],
    [openaiJson(oauth), 'connected'],
    [openaiJson(oauth, oauth), 'connected'],
    [openaiJson({ ...oauth, status: { status: 'needs_auth' } }), 'disconnected'],
    [openaiJson(oauth, { type: 'credential', method: 'api' }), 'unknown'],
    [openaiJson(oauth, { type: 'environment' }), 'unknown'],
    [openaiJson({ ...oauth, status: { status: 'new-vendor-state' } }), 'unknown'],
    [openaiJson(oauth, null), 'unknown'],
    [openaiJson(), 'unknown'],
    ['[null]', 'unknown'],
    ['[{', 'unknown'],
    [stored(['OpenAI api']), 'disconnected'],
    [stored([]), 'disconnected'],
    ['[]', 'disconnected'],
    ['No authenticated integrations', 'disconnected'],
    [stored(['OpenAI oauth', 'OpenAI api']), 'unknown'],
    [stored(['OpenAI oauth']) + '\n┌  Environment\n●  OpenAI OPENAI_API_KEY\n└  1 environment variable', 'unknown'],
    [stored(['OpenAI oauth'], 2), 'unknown'],
    [stored(['OpenAI oauth']) + '\n' + stored(['OpenAI api']), 'unknown'],
    [stored(['OpenAI wellknown']), 'unknown'],
    [stored(['OpenAI Compatible oauth']), 'unknown'],
    [stored(['Anthropic oauth']), 'unknown'],
    ['OpenAI  OpenAI                 stored', 'unknown'],
    ['[{"id":"openai","connections":[{"type":"credential","label":"OpenAI"}]}]', 'unknown'],
    ['●  OpenAI oauth', 'unknown'],
    ['', 'unknown'],
  ])('reads only a complete, explicitly typed credential list (%#)', (stdout, expected) => {
    expect(openCodeSubscriptionStatus({ stdout, stderr: '', exitCode: 0 })).toBe(expected);
  });

  it.each([{ exitCode: 1 }, { timedOut: true }, { errorCode: 'EACCES' }, { signal: 'SIGTERM' }])(
    'discards a failed or interrupted list', failure => {
      expect(openCodeSubscriptionStatus({ stdout: stored(['OpenAI oauth']), stderr: '', exitCode: 0, ...failure })).toBe('unknown');
    },
  );
});
