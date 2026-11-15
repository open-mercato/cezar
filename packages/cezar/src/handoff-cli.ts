/**
 * `cez handoff …` — the CLI a running agent uses to keep its handoff journal (spec 007) current,
 * instead of hand-typing a python heredoc for every Progress-log line (agents-master I049: the
 * same script was retyped across 7+ runs). It only edits the file named by `CEZ_HANDOFF_FILE`,
 * which every agent process gets; no server, no network.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { insertProgressLine, progressLine, replaceResumeNotes } from './handoff.ts';

export interface HandoffCliEnv {
  CEZ_HANDOFF_FILE?: string;
}

export interface HandoffCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
  /** Whole stdin, or null when stdin is a terminal (nothing was piped in). */
  readStdin: () => Promise<string | null>;
  now: () => Date;
}

const USAGE = `cez handoff — update this task's handoff file ($CEZ_HANDOFF_FILE)

  cez handoff log "<text>"     insert "- <timestamp> — <text>" under ## Progress log (newest at the top)
  cez handoff resume "<text>"  replace the ## Resume notes section with <text>
  cez handoff resume <<'EOF'   … or with stdin (multi-line notes)
  cez handoff resume ""        clear ## Resume notes (only when the task is truly complete)`;

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function runHandoffCommand(
  args: string[],
  env: HandoffCliEnv = process.env,
  io: HandoffCliIo = { log: console.log, error: console.error, readStdin, now: () => new Date() },
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.log(USAGE);
    return command ? 0 : 2;
  }
  if (command !== 'log' && command !== 'resume') {
    io.error(`cez handoff: unknown command "${command}"\n\n${USAGE}`);
    return 2;
  }
  const file = env.CEZ_HANDOFF_FILE;
  if (!file) {
    io.error('cez handoff: CEZ_HANDOFF_FILE is not set — this command only works inside a cezar task.');
    return 2;
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    io.error(`cez handoff: cannot read ${file}: ${(err as Error).message}`);
    return 1;
  }

  let next: string;
  if (command === 'log') {
    const note = rest.join(' ').trim();
    if (!note) {
      io.error('cez handoff log: give the line to log, e.g. cez handoff log "tests pass"');
      return 2;
    }
    next = insertProgressLine(text, progressLine(note, io.now()));
  } else {
    // An argument (even "") wins; otherwise piped stdin; a bare `resume` at a terminal is a
    // usage error rather than a silent clear.
    const notes = rest.length > 0 ? rest.join(' ') : await io.readStdin();
    if (notes === null) {
      io.error('cez handoff resume: give the notes as an argument or on stdin ("" clears them)');
      return 2;
    }
    next = replaceResumeNotes(text, notes);
  }

  try {
    writeFileSync(file, next, 'utf8');
  } catch (err) {
    io.error(`cez handoff: cannot write ${file}: ${(err as Error).message}`);
    return 1;
  }
  io.log(command === 'log' ? 'cez handoff: logged under ## Progress log' : 'cez handoff: ## Resume notes updated');
  return 0;
}
