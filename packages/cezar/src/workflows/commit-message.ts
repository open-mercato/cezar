import { execFile } from 'node:child_process';
import { z } from 'zod';
import { loadConfig } from '../config.ts';
import { createRunner } from '../core/runner-factory.ts';
import { parseStructured } from '../planner.ts';
import { autoNamingActive, NAMER_TIMEOUT_MS } from '../runs/auto-name.ts';
import { resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';
import type { StagedChange } from './landing.ts';

/**
 * A landing commit's message, written by the namer model from the staged change itself (spec
 * 2026-10-20-trunk-based-projects) — never the task title, which describes the first request
 * and goes stale across follow-ups. Same rules as the namer: cheap model, never throws, never
 * blocks a landing; undefined lets the caller fall back to the file list.
 */

const SUBJECT_MAX = 72;

export const COMMIT_MESSAGE_SYSTEM_PROMPT =
  'You write git commit subject lines. Respond with ONLY a JSON object: {"subject": string}. The subject ' +
  'says what THIS change does, in the imperative mood ("Add …", "Summarize …", "Update …"), at most 72 ' +
  'characters, one line, no trailing period. Match the style of the repository\'s recent subjects when ' +
  'they show a convention (a prefix, a language, a format). Never comment on, judge or explain the ' +
  'change, never ask a question, never address the reader.';

const subjectSchema = z.object({ subject: z.string() });

export function buildCommitMessagePrompt(staged: StagedChange, intent?: string, recent: string[] = []): string {
  const files = staged.files.map((f) => `${f.status}\t${f.path}`).join('\n');
  return [
    recent.length ? `Recent commit subjects in this repository (style examples):\n${recent.join('\n')}` : undefined,
    intent ? `The request that produced the change (context only): ${intent.slice(0, 500)}` : undefined,
    `Files:\n${files}`,
    `Diff:\n${staged.patch}`,
  ].filter(Boolean).join('\n\n');
}

/**
 * The model's answer → a usable subject, or undefined. Refuses rather than repairs: a subject that
 * had to be cut, or that reads as a remark about the change ("The names in … are a…"), is worse
 * than the file-list fallback.
 */
export function cleanSubject(raw: string): string | undefined {
  const parsed = parseStructured(raw, subjectSchema);
  const subject = parsed?.subject.trim().replace(/\.$/, '').trim();
  if (!subject || subject.length > SUBJECT_MAX || /[\n?…]/.test(subject)) return undefined;
  if (/^(the|this|these|those|it|its|i|here|sure|okay|ok|there)\b/i.test(subject)) return undefined;
  return subject;
}

async function recentSubjects(repoRoot: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('git', ['log', '-8', '--format=%s'], { cwd: repoRoot, encoding: 'utf8' }, (err, stdout) =>
      resolve(err ? [] : stdout.split('\n').map((l) => l.trim()).filter(Boolean)),
    );
  });
}

export async function generateCommitMessage(
  repoRoot: string,
  staged: StagedChange,
  intent?: string,
): Promise<string | undefined> {
  if (!autoNamingActive() || staged.files.length === 0) return undefined;
  try {
    const config = await loadConfig(repoRoot);
    const runner = createRunner(config.defaultRunner);
    const { env } = await resolveProfileEnvForRoot(repoRoot, config.defaultRunner);
    const userPrompt = buildCommitMessagePrompt(staged, intent, await recentSubjects(repoRoot));
    // One retry, like the namer: a junk answer gets a second chance, then the file-list fallback.
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await runner.run({
        systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
        userPrompt,
        cwd: repoRoot,
        allowedTools: [],
        model: config.defaultRunner === 'claude' ? config.namerModel : undefined,
        timeoutMs: NAMER_TIMEOUT_MS,
        env: { ...env, CEZ_MOCK_ARGS_FILE: '' },
      });
      const subject = cleanSubject(result.text);
      if (subject) return subject;
    }
  } catch {
    // runner unavailable — the file-list fallback
  }
  return undefined;
}
