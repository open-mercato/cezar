import { describe, expect, it } from 'vitest';
import { parseStructured } from '../../../src/actions/autofix/agent-session.js';
import { AnalyzerResultSchema } from '../../../src/actions/autofix/prompts/analyzer.js';

describe('parseStructured', () => {
  it('parses the final JSON object when earlier prose contains non-JSON braces', () => {
    const raw = `Perfect! The API endpoint exists and expects { token: string, password: string }.
This is a gap where the backend functionality is implemented but the frontend page was never created.

{
  "summary": "Password reset frontend page missing",
  "suspectedFiles": ["packages/core/src/modules/portal/frontend/[orgSlug]/portal"],
  "hypothesis": "The admin generates a reset URL that points to a frontend route that does not exist.",
  "reproductionNotes": "Open the reset link from the admin email flow.",
  "confidence": 0.95
}`;

    expect(parseStructured(raw, AnalyzerResultSchema)).toEqual({
      summary: 'Password reset frontend page missing',
      suspectedFiles: ['packages/core/src/modules/portal/frontend/[orgSlug]/portal'],
      hypothesis:
        'The admin generates a reset URL that points to a frontend route that does not exist.',
      reproductionNotes: 'Open the reset link from the admin email flow.',
      confidence: 0.95,
    });
  });
});
