import { loadConfig } from '../config.ts';
import { createRunner } from '../core/runner-factory.ts';
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
  'You write git commit messages. Respond with ONLY the subject line: imperative mood, at most 72 ' +
  'characters, no trailing period, no quotes, no prefix like "feat:". Describe what THIS change does ' +
  'to the files, in the language the content is written in.';

export function buildCommitMessagePrompt(staged: StagedChange, intent?: string): string {
  const files = staged.files.map((f) => `${f.status}\t${f.path}`).join('\n');
  return [
    intent ? `The request that produced it (context only): ${intent.slice(0, 500)}` : undefined,
    `Files:\n${files}`,
    `Diff:\n${staged.patch}`,
  ].filter(Boolean).join('\n\n');
}

/** The model's answer → one clean subject line, or undefined for junk. */
export function cleanSubject(raw: string): string | undefined {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('```'));
  if (!line) return undefined;
  const subject = line.replace(/^["'`]|["'`]$/g, '').replace(/\.$/, '').trim();
  if (!subject || /^cez-namer|^\{/.test(subject)) return undefined;
  return subject.length > SUBJECT_MAX ? `${subject.slice(0, SUBJECT_MAX - 1).trimEnd()}…` : subject;
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
    const result = await runner.run({
      systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
      userPrompt: buildCommitMessagePrompt(staged, intent),
      cwd: repoRoot,
      allowedTools: [],
      model: config.defaultRunner === 'claude' ? config.namerModel : undefined,
      timeoutMs: NAMER_TIMEOUT_MS,
      env: { ...env, CEZ_MOCK_ARGS_FILE: '' },
    });
    return cleanSubject(result.text);
  } catch {
    return undefined;
  }
}
