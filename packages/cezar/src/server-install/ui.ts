import * as clack from '@clack/prompts';
import { CANCEL, PreflightError, type Cancellable, type SpinnerHandle, type Ui } from './types.ts';
import { StepAborted } from './steps.ts';

/**
 * The interactive surface, implemented over `@clack/prompts` — the one place
 * the TUI library is imported. `types.ts`, the engine and the steps talk to
 * the `Ui` interface only, so `@clack/prompts` never enters the server/runtime
 * import graph (AGENTS.md keeps that stack tiny).
 *
 * Every prompt maps clack's cancel symbol to the `CANCEL` sentinel instead of
 * throwing, so a Ctrl-C mid-install is a value the engine can persist-and-exit
 * on, not an exception.
 */

/** The subset of `@clack/prompts` the UI uses — injectable for unit tests. */
export interface PromptBackend {
  intro: typeof clack.intro;
  outro: typeof clack.outro;
  note: typeof clack.note;
  log: typeof clack.log;
  select: typeof clack.select;
  multiselect: typeof clack.multiselect;
  confirm: typeof clack.confirm;
  text: typeof clack.text;
  password: typeof clack.password;
  spinner: typeof clack.spinner;
  isCancel: typeof clack.isCancel;
}

const realBackend: PromptBackend = {
  intro: clack.intro,
  outro: clack.outro,
  note: clack.note,
  log: clack.log,
  select: clack.select,
  multiselect: clack.multiselect,
  confirm: clack.confirm,
  text: clack.text,
  password: clack.password,
  spinner: clack.spinner,
  isCancel: clack.isCancel,
};

/** Map a clack result to `T | CANCEL`, never a thrown cancel. */
function unwrap<T>(value: T | symbol, isCancel: PromptBackend['isCancel']): Cancellable<T> {
  return isCancel(value) ? CANCEL : (value as T);
}

/** The real interactive UI. */
export function createClackUi(backend: PromptBackend = realBackend): Ui {
  // clack renders a prompt at stdin-EOF and never resolves — a piped/ssh'd
  // invocation would hang forever while holding the single-writer install
  // lock. Refuse up front with the way out. (Injected fake backends are for
  // tests, which have no TTY.)
  if (backend === realBackend && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new PreflightError(
      'this terminal is not interactive — re-run from a TTY, or pass --yes (or CEZ_DRY_RUN=1) for non-interactive mode',
    );
  }
  const wrapValidate = (validate?: (v: string) => string | undefined) =>
    validate ? (v: string | undefined) => validate(v ?? '') : undefined;

  return {
    intro: (m) => backend.intro(m),
    outro: (m) => backend.outro(m),
    note: (m, title) => backend.note(m, title),
    // Raw, un-boxed: clack's note() draws a bordered box that breaks when a long
    // command wraps. Write straight to stdout so the command stays selectable.
    message: (m) => process.stdout.write(`\n${m}\n`),
    info: (m) => backend.log.info(m),
    success: (m) => backend.log.success(m),
    warn: (m) => backend.log.warn(m),
    error: (m) => backend.log.error(m),
    async select<T>(opts: {
      message: string;
      options: Array<{ value: T; label: string; hint?: string }>;
      initialValue?: T;
    }) {
      // clack's `Option<Value>` is a conditional type that can't resolve against
      // an unconstrained generic; cast the options and keep the explicit T.
      const res = await backend.select<T>({
        message: opts.message,
        options: opts.options as never,
        initialValue: opts.initialValue,
      });
      return unwrap(res, backend.isCancel);
    },
    async multiselect<T>(opts: {
      message: string;
      options: Array<{ value: T; label: string; hint?: string }>;
      required?: boolean;
    }) {
      const res = await backend.multiselect<T>({
        message: opts.message,
        options: opts.options as never,
        required: opts.required ?? false,
      });
      return unwrap(res, backend.isCancel);
    },
    async confirm(opts) {
      return unwrap(await backend.confirm(opts), backend.isCancel);
    },
    async text(opts) {
      return unwrap(await backend.text({ ...opts, validate: wrapValidate(opts.validate) }), backend.isCancel);
    },
    async password(opts) {
      return unwrap(await backend.password({ ...opts, validate: wrapValidate(opts.validate) }), backend.isCancel);
    },
    spinner(): SpinnerHandle {
      const s = backend.spinner();
      return {
        start: (m) => s.start(m),
        stop: (m) => s.stop(m),
        message: (m) => s.message(m),
      };
    },
  };
}

/**
 * Non-interactive UI for `--yes`, `CEZ_DRY_RUN`, and unit tests. Prompts resolve
 * to deterministic safe defaults (initial value, or the first option, or ""),
 * logs go to the console. It never touches stdin, so it can drive the engine
 * headless. Optional `answers` override defaults per-prompt-message.
 */
export function createAutoUi(
  answers: Record<string, unknown> = {},
  sink: (m: string) => void = () => {},
  opts: {
    /**
     * Enforce each prompt's `validate` on auto-answers (real `--yes` runs must
     * fail closed on an unanswerable prompt). Off for CEZ_DRY_RUN previews,
     * which must walk every step with placeholder-grade values.
     */
    strictValidate?: boolean;
  } = {},
): Ui {
  const answer = <T>(message: string, fallback: T): T =>
    (message in answers ? (answers[message] as T) : fallback);
  const checkValid = (message: string, v: string, validate?: (v: string) => string | undefined): void => {
    if (!opts.strictValidate) return;
    const invalid = validate?.(v);
    if (invalid !== undefined) {
      throw new StepAborted(`cannot auto-answer "${message}" (${invalid}) — run without --yes to answer it`);
    }
  };
  return {
    intro: sink,
    outro: sink,
    note: (m) => sink(m),
    message: sink,
    info: sink,
    success: sink,
    warn: sink,
    error: sink,
    async select(opts) {
      return answer(opts.message, opts.initialValue ?? opts.options[0]?.value) as never;
    },
    async multiselect(opts) {
      return answer(opts.message, [] as unknown[]) as never;
    },
    async confirm(opts) {
      return answer(opts.message, opts.initialValue ?? true);
    },
    // A placeholder is a HINT, never an answer — auto-adopting it turned the
    // example domain `cezar.ngrok.app` into real input under `--yes`.
    async text(o) {
      const v = String(answer(o.message, o.initialValue ?? ''));
      checkValid(o.message, v, o.validate);
      return v;
    },
    async password(o) {
      const v = String(answer(o.message, ''));
      checkValid(o.message, v, o.validate);
      return v;
    },
    spinner(): SpinnerHandle {
      return { start: (m) => m && sink(m), stop: (m) => m && sink(m), message: (m) => sink(m) };
    },
  };
}
