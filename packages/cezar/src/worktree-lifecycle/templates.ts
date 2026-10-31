import { createHash } from 'node:crypto';
import type { LifecycleTemplateVariables } from '@open-mercato/cezar-contract';
import { shellQuote } from '../core/shell-env.ts';

export const LIFECYCLE_RENDERER_VERSION = 'bash-posix-quote-v1';
export const LIFECYCLE_VARIABLES = ['root_path', 'worktree_path', 'worktree_id', 'task_id'] as const;
export type LifecycleTemplateContext = LifecycleTemplateVariables;

export class LifecycleTemplateError extends Error {
  constructor(message: string, readonly position: number) {
    super(`${message} (position ${position + 1})`);
    this.name = 'LifecycleTemplateError';
  }
}

/** This is deliberately a lexer, not a Bash interpreter. Complex grammar remains Bash's
 * business, but a template is accepted only where a quoted ordinary word is safe. */
function render(command: string, context?: LifecycleTemplateContext): string {
  if (!command.trim()) throw new LifecycleTemplateError('Enter a command', 0);
  if (command.includes('\0')) throw new LifecycleTemplateError('Commands cannot contain NUL', command.indexOf('\0'));
  if (!command.includes('{{')) return command;
  const stack: { kind: string; close: string }[] = [];
  let result = '';
  let hereDocument = false;
  for (let i = 0; i < command.length;) {
    const top = stack.at(-1);
    // Escaped delimiters are literal even inside quotes; do not rescan their contents.
    if (command.startsWith('\\{{', i)) {
      const end = command.indexOf('}}', i + 3);
      if (end < 0) { result += command.slice(i + 1); break; }
      result += command.slice(i + 1, end + 2); i = end + 2; continue;
    }
    if (command.startsWith('{{', i)) {
      const end = command.indexOf('}}', i + 2);
      if (end < 0) throw new LifecycleTemplateError('Close the template with }}', i);
      if (top || hereDocument) throw new LifecycleTemplateError(`Place template variables unquoted in ordinary shell arguments, outside ${top?.kind ?? 'here-documents'}`, i);
      if (command[i - 1] === '$') throw new LifecycleTemplateError('Do not prefix a template with $; Cezar adds shell quoting', i);
      const name = command.slice(i + 2, end).trim();
      if (!(LIFECYCLE_VARIABLES as readonly string[]).includes(name)) throw new LifecycleTemplateError(`Unknown variable ${JSON.stringify(name)}; available: ${LIFECYCLE_VARIABLES.join(', ')}`, i);
      const value = context?.[name as keyof LifecycleTemplateContext];
      if (context && (typeof value !== 'string' || value.length === 0)) throw new LifecycleTemplateError(`Variable ${name} is unavailable`, i);
      if (value && /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new LifecycleTemplateError(`Variable ${name} contains control characters`, i);
      result += value === undefined ? command.slice(i, end + 2) : shellQuote(value);
      i = end + 2; continue;
    }
    if (command.startsWith('}}', i)) throw new LifecycleTemplateError('Unexpected }}; escape literal braces with \\{{', i);
    const char = command[i]!;
    if (top?.kind === 'comments') {
      result += char; i++; if (char === '\n') stack.pop(); continue;
    }
    if (top && command.startsWith(top.close, i)) {
      result += top.close; i += top.close.length; stack.pop(); continue;
    }
    if (char === '\\' && top?.kind !== 'single quotes') {
      // A backslash immediately before a template is handled above; otherwise it
      // escapes one shell character, so the lexer must not interpret that character.
      result += command.slice(i, i + 2); i += 2; continue;
    }
    if (top?.kind === 'single quotes') { result += char; i++; continue; }
    if (char === '"' || (char === "'" && top?.kind !== 'double quotes')) {
      stack.push({ kind: char === '"' ? 'double quotes' : 'single quotes', close: char });
    } else if (char === '`') {
      stack.push({ kind: 'backticks', close: '`' });
    } else if (command.startsWith('$((', i) || command.startsWith('((', i)) {
      const token = command.startsWith('$((', i) ? '$((' : '((';
      stack.push({ kind: 'shell arithmetic', close: '))' }); result += token; i += token.length; continue;
    } else if (command.startsWith('$(', i) || command.startsWith('<(', i) || command.startsWith('>(', i)) {
      stack.push({ kind: 'command/process substitutions', close: ')' }); result += command.slice(i, i + 2); i += 2; continue;
    } else if (command.startsWith('${', i)) {
      stack.push({ kind: 'parameter expansions', close: '}' }); result += '${'; i += 2; continue;
    } else if (command.startsWith('[[', i)) {
      stack.push({ kind: 'conditional expressions', close: ']]' }); result += '[['; i += 2; continue;
    } else if (char === '[' && !top && i > 0 && !/[\s;|&()]/.test(command[i - 1]!)) {
      stack.push({ kind: 'array subscripts or glob character classes', close: ']' });
    } else if (char === '(' && top && top.kind !== 'double quotes') {
      stack.push({ kind: top.kind, close: ')' });
    } else if (char === '#' && (!i || /[\s;|&()]/.test(command[i - 1]!)) && top?.kind !== 'double quotes') {
      stack.push({ kind: 'comments', close: '\n' });
    } else if (command.startsWith('<<', i) && top?.kind !== 'double quotes') {
      // Heredoc delimiter expansion and bodies are intentionally not interpreted.
      // Conservatively exclude subsequent placeholders even after the terminator.
      hereDocument = true;
    }
    result += char; i++;
  }
  return result;
}

export function validateLifecycleCommand(command: string): void { render(command); }
export function renderLifecycleCommand(command: string, context: LifecycleTemplateContext): string { return render(command, context); }
export function lifecycleCommandFingerprint(command: string, context: LifecycleTemplateContext): string {
  return createHash('sha256').update(JSON.stringify([LIFECYCLE_RENDERER_VERSION, command, ...LIFECYCLE_VARIABLES.map(name => context[name])])).digest('hex');
}
