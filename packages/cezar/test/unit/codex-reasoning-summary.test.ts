import assert from 'node:assert/strict';
import test from 'node:test';
import { reasoningSummary } from '../../src/core/codex-app-server-runner.js';

test('reasoningSummary defaults to auto so codex reasoning is visible out of the box', () => {
  assert.equal(reasoningSummary({}), 'auto');
  assert.equal(reasoningSummary({ CEZ_CODEX_REASONING: '' }), 'auto');
  assert.equal(reasoningSummary({ CEZ_CODEX_REASONING: '   ' }), 'auto');
});

test('reasoningSummary honors a recognized override, case- and space-insensitively', () => {
  assert.equal(reasoningSummary({ CEZ_CODEX_REASONING: 'concise' }), 'concise');
  assert.equal(reasoningSummary({ CEZ_CODEX_REASONING: 'DETAILED' }), 'detailed');
  assert.equal(reasoningSummary({ CEZ_CODEX_REASONING: '  none ' }), 'none');
});

test('reasoningSummary falls back to auto for an unrecognized value', () => {
  assert.equal(reasoningSummary({ CEZ_CODEX_REASONING: 'verbose' }), 'auto');
  assert.equal(reasoningSummary({ CEZ_CODEX_REASONING: '0' }), 'auto');
});
