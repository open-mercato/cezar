import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Config } from '../config/config.model.js';
import type { StoredIssue, IssueDigest } from '../store/store.model.js';
import { chunkArray } from '../utils/chunker.js';

const DigestResponseSchema = z.object({
  digests: z.array(
    z.object({
      number: z.number(),
      summary: z.string(),
      category: z.enum(['bug', 'feature', 'docs', 'chore', 'question', 'other']),
      affectedArea: z.string(),
      keywords: z.array(z.string()),
    }),
  ),
});

export const DuplicateResponseSchema = z.object({
  duplicates: z.array(
    z.object({
      number: z.number(),
      duplicateOf: z.number(),
      confidence: z.number().min(0).max(1),
      reason: z.string(),
    }),
  ),
});

export type DuplicateMatch = z.infer<typeof DuplicateResponseSchema>['duplicates'][number];

export class LLMService {
  /** Max retry attempts for transient Anthropic errors (429/529/5xx). */
  private static readonly MAX_RETRIES = 4;

  private client: Anthropic;
  private model: string;
  private maxTokens: number;

  constructor(config: Config) {
    if (!config.llm.apiKey) {
      throw new Error('Missing Anthropic API key. Check ANTHROPIC_API_KEY env var.');
    }
    this.client = new Anthropic({ apiKey: config.llm.apiKey });
    this.model = config.llm.model;
    this.maxTokens = config.llm.maxTokens;
  }

  async generateDigests(
    issues: Array<{ number: number; title: string; body: string }>,
    batchSize: number,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<Map<number, IssueDigest>> {
    const results = new Map<number, IssueDigest>();
    const batches = chunkArray(issues, batchSize);
    let completed = 0;

    for (const batch of batches) {
      const prompt = this.buildDigestPrompt(batch);
      const raw = await this.callLLM(prompt);
      const parsed = this.parseJSON(raw, DigestResponseSchema);

      if (parsed) {
        for (const d of parsed.digests) {
          results.set(d.number, {
            summary: d.summary,
            category: d.category,
            affectedArea: d.affectedArea,
            keywords: d.keywords,
            digestedAt: new Date().toISOString(),
          });
        }
      }

      completed += batch.length;
      onProgress?.(completed, issues.length);
    }

    return results;
  }

  async detectDuplicates(
    candidates: StoredIssue[],
    knowledgeBase: StoredIssue[],
  ): Promise<DuplicateMatch[]> {
    const prompt = this.buildDuplicatePrompt(candidates, knowledgeBase);
    const raw = await this.callLLM(prompt);
    const parsed = this.parseJSON(raw, DuplicateResponseSchema);
    return parsed?.duplicates ?? [];
  }

  /**
   * Generic analysis method — actions provide their own prompt and response schema.
   * Returns null if the LLM response cannot be parsed.
   */
  async analyze<T>(prompt: string, schema: z.ZodSchema<T>): Promise<T | null> {
    const raw = await this.callLLM(prompt);
    return this.parseJSON(raw, schema);
  }

  private buildDigestPrompt(
    issues: Array<{ number: number; title: string; body: string }>,
  ): string {
    const issueList = issues
      .map((i) => `#${i.number}: ${i.title}\n${i.body.slice(0, 2000)}`)
      .join('\n\n---\n\n');

    return `Analyze the following GitHub issues and generate a compact digest for each.

For each issue, provide:
- summary: A concise one-line summary (max 100 chars)
- category: One of: bug, feature, docs, chore, question, other
- affectedArea: The part of the system affected (e.g. "auth", "API", "UI", "build")
- keywords: 3-5 keywords for similarity matching

Issues:
${issueList}

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "digests": [
    {
      "number": 123,
      "summary": "...",
      "category": "bug",
      "affectedArea": "...",
      "keywords": ["...", "..."]
    }
  ]
}`;
  }

  private buildDuplicatePrompt(candidates: StoredIssue[], knowledgeBase: StoredIssue[]): string {
    const formatCompact = (issue: StoredIssue): string => {
      const d = issue.digest!;
      return `#${issue.number} [${d.category}] ${d.affectedArea} | ${d.summary} | kw: ${d.keywords.join(', ')}`;
    };

    return `KNOWLEDGE BASE — all open issues (compact digest format):
${knowledgeBase.map(formatCompact).join('\n')}

CANDIDATES — check each of these against the knowledge base for duplicates:
${candidates.map(formatCompact).join('\n')}

An issue is a duplicate if it describes the same underlying problem or feature request,
even if the wording is completely different.

Rules:
- A candidate can only be a duplicate of a KNOWLEDGE BASE issue (not another candidate)
- The original is always the lower-numbered issue
- Only include candidates that ARE duplicates (omit non-duplicates entirely)
- Minimum confidence to include: 0.80
- If unsure, omit rather than guess

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "duplicates": [
    {
      "number": 456,
      "duplicateOf": 123,
      "confidence": 0.95,
      "reason": "One sentence explaining why these are the same issue"
    }
  ]
}`;
  }

  private async callLLM(prompt: string, attempt = 0): Promise<string> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      });

      const textBlock = response.content.find((b) => b.type === 'text');
      return textBlock?.text ?? '';
    } catch (err: any) {
      // Retry transient Anthropic errors with exponential backoff:
      // 429 rate_limit_error, 529 overloaded_error, and 5xx server errors.
      const status: number | undefined = err?.status;
      const retryable =
        status === 429 || status === 529 || (typeof status === 'number' && status >= 500);
      if (retryable && attempt < LLMService.MAX_RETRIES) {
        const retryAfter = Number(err?.headers?.['retry-after']) * 1000;
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt * 1000;
        await new Promise((r) => setTimeout(r, delay));
        return this.callLLM(prompt, attempt + 1);
      }
      throw err;
    }
  }

  private parseJSON<T>(raw: string, schema: z.ZodSchema<T>): T | null {
    try {
      // Strip markdown code fences if present
      const cleaned = raw
        .replace(/^```json?\s*\n?/m, '')
        .replace(/\n?```\s*$/m, '')
        .trim();
      const parsed = JSON.parse(cleaned);
      return schema.parse(parsed);
    } catch (firstError) {
      // Retry: try to extract JSON from the response
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          return schema.parse(parsed);
        }
      } catch {
        // Both attempts failed
      }
      return null;
    }
  }
}
