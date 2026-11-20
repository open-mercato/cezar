/**
 * Words and `|` separators, or a reason. Only plain words, single quotes and double quotes without
 * expansion: every other shell metacharacter — `;`, `&`, `$`, backticks, redirects, subshells,
 * globs, unquoted newlines — refuses the whole command rather than being interpreted.
 */
export function tokenizePlainShell(command: string): string[][] | string {
  const segments: string[][] = [[]];
  let word: string | undefined;
  const end = () => {
    if (word !== undefined) segments[segments.length - 1]!.push(word);
    word = undefined;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === ' ' || ch === '\t') {
      end();
    } else if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return 'an unterminated quote';
      // Quoted newlines are literal: a multi-line objective is one word.
      word = (word ?? '') + command.slice(i + 1, close);
      i = close;
    } else if (ch === '"') {
      let body = '';
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const c = command[j]!;
        if (c === '$' || c === '`') return `\`${c}\` (expansion)`;
        if (c === '\\') {
          const next = command[j + 1];
          if (next !== '"' && next !== '\\') return 'a backslash escape';
          body += next;
          j++;
        } else {
          body += c;
        }
      }
      if (j >= command.length) return 'an unterminated quote';
      word = (word ?? '') + body;
      i = j;
    } else if (ch === '|') {
      if (command[i + 1] === '|') return '`||`';
      end();
      if (segments[segments.length - 1]!.length === 0) return 'an empty pipe stage';
      segments.push([]);
    } else if (/[A-Za-z0-9_.,:/=@%+\-]/.test(ch)) {
      word = (word ?? '') + ch;
    } else {
      return ch === '\n' || ch === '\r' ? 'a newline' : `\`${ch}\``;
    }
  }
  end();
  if (segments[segments.length - 1]!.length === 0) return 'an empty pipe stage';
  return segments;
}

