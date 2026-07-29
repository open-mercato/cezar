import type { Context, Env, MiddlewareHandler } from 'hono';
import { validator } from 'hono/validator';
import type { z } from 'zod';

/**
 * Request validation as ROUTE MIDDLEWARE — the `json` / `param` / `query` trio every mutating
 * route reaches for.
 *
 * The point is not that handlers stop restating six lines of `safeParse`, though they do. It is
 * that Hono only records a validated shape in the ROUTE TYPE when validation happens as
 * middleware. Parsing inside a handler is invisible to it, which is why `POST /runs` used to
 * accept `{ totalNonsense: 12345 }` from `hc` without a murmur. Everything typed-client-side
 * flows from validating here instead of there.
 *
 * ## Why not `@hono/zod-validator`
 *
 * It is a thin wrapper over the same `hono/validator` used below, so it inherits Hono's two
 * behaviours at the JSON boundary — and both are wrong for this server:
 *
 *   - a malformed body answers Hono's PLAIN-TEXT `400 Malformed JSON in request body`, and the
 *     error hook never runs, so the `{error}` shape BACKWARD_COMPATIBILITY.md §2 protects (and
 *     the cockpit renders verbatim in a toast) is bypassed entirely;
 *   - a body sent WITHOUT a JSON content-type is silently discarded and the handler runs against
 *     `{}` — a 200 that applied an empty update, which is worse than a rejection.
 *
 * Both were verified against `@hono/zod-validator@0.9.0`, not inferred. `jsonZodValidator` settles
 * those cases itself and only delegates to Hono on the well-formed path, so the wire matches what
 * these handlers did when they parsed inline (`await c.req.json().catch(() => absent)`).
 */

type ErrorOptions = {
  /** Fixed 400 text, for routes that answer one instead of the zod issues. */
  message?: string;
};

type JsonOptions = ErrorOptions & {
  /**
   * What a request with NO body parses as — the old `.catch(() => …)` fallback. Hono hands a
   * bodyless request `{}`, which is not the same as a request that really sent `{}`: routes that
   * tolerate no body at all pass `{}` here, and the rest keep rejecting it exactly as they did.
   */
  absent?: unknown;
  /**
   * What a body that is PRESENT but not parseable as JSON becomes. Defaults to `absent`, which is
   * what every route wants when both cases are rejected anyway.
   *
   * `POST /todos/:id/start` is the one route that must tell them apart: no body at all is the
   * pre-#401 bodyless POST and has to succeed (`absent: undefined`, which its optional schema
   * accepts), while a truncated payload must 400 rather than pass as "no body" and silently 201
   * (`malformed: null`, which it does not). That distinction lived in the handler's own
   * `JSON.parse` before the route moved its body onto a validator; it is expressed here so the
   * behaviour moved with it rather than being lost in the move.
   */
  malformed?: unknown;
};

/**
 * `{ error }`, the one 400 shape this API answers (BACKWARD_COMPATIBILITY.md §2).
 *
 * Each issue is prefixed with the field path, because zod's own message never names the field:
 * `"Invalid input: expected array, received undefined"` on its own does not tell the cockpit user
 * WHICH field to fix. That is the same information `z.prettifyError` adds, minus its multi-line
 * `✖ …\n  → at task` layout — this string is rendered verbatim in a toast, so it stays one line.
 */
function reject(c: Context, error: z.ZodError, override: string | undefined) {
  const detail = error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
  return c.json({ error: override ?? detail }, 400);
}

/**
 * The request/response split, spelled out rather than inferred.
 *
 * Hono derives a validator's request type from its validation function's first parameter, but
 * declares that parameter as a CONDITIONAL type — which is not an inference site, so annotating
 * it achieves nothing and the request silently falls back to the schema's OUTPUT. That makes any
 * `.optional().transform(…)` or `.default(…)` field REQUIRED on the wire: `POST /runs` demanded a
 * `systemPrompt` no caller should send, and `POST …/merge` demanded `overrideRules`. Naming both
 * sides here is the same thing `@hono/zod-validator` does, and for the same reason.
 */
type JsonValidator<S extends z.ZodType, E extends Env, P extends string> = MiddlewareHandler<
  E,
  P,
  { in: { json: z.input<S> }; out: { json: z.output<S> } }
>;

export function jsonZodValidator<
  S extends z.ZodType,
  E extends Env = Env,
  P extends string = string,
>(
  // A thunk is accepted because several schemas are declared next to the route family they
  // belong to, which is BELOW the route using them; resolving per request keeps those
  // declarations where they read best. Pass the schema directly whenever it is already in scope —
  // a GENERIC thunk is worse than either, since an unresolved schema type makes Hono drop the
  // route from the app type silently (see typed-bodies.test.ts).
  schema: S | (() => S),
  options: JsonOptions = {},
): JsonValidator<S, E, P> {
  // Key presence, not a destructuring default: `undefined` IS a meaningful value for both of
  // these (it is what `POST /todos/:id/start` wants a bodyless request to parse as), and a
  // `= null` default would silently overwrite exactly that case.
  const absent = 'absent' in options ? options.absent : null;
  const malformed = 'malformed' in options ? options.malformed : absent;
  const { message } = options;
  const check = (input: unknown, c: Context) => {
    const resolved = typeof schema === 'function' ? schema() : schema;
    const parsed = resolved.safeParse(input);
    return parsed.success
      ? ({ ok: true, data: parsed.data as z.infer<S> } as const)
      : ({ ok: false, response: reject(c, parsed.error, message) } as const);
  };

  const validate = validator('json', (value, c) => {
    const result = check(value, c);
    return result.ok ? result.data : result.response;
  });

  // Anything Hono would treat differently than the old inline parse is settled here and published
  // straight to `c.req.valid('json')`; only well-formed JSON under a JSON content-type — what
  // every real client sends — takes Hono's own path. See the header note.
  const guard: typeof validate = async (c, next) => {
    const text = await c.req.text().catch(() => '');
    let body: unknown = absent;
    let parseable = false;
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text);
        parseable = true;
      } catch {
        body = malformed;
      }
    }
    const contentType = c.req.header('content-type');
    if (parseable && contentType !== undefined && /^application\/([a-z\-.]+\+)?json/.test(contentType)) {
      return validate(c, next);
    }
    const result = check(body, c);
    if (!result.ok) return result.response;
    c.req.addValidatedData('json', result.data as never);
    return next();
  };
  return guard as unknown as JsonValidator<S, E, P>;
}

/**
 * Path params. No guard needed: these come off the matched URL, so there is no body to parse, no
 * content-type to gate on and no malformed-input path — Hono's own behaviour is already right.
 * The schema receives the whole param object (`{ provider: 'codex' }`), not a single value.
 */
export function paramZodValidator<S extends z.ZodType>(schema: S, { message }: ErrorOptions = {}) {
  return validator('param', (value, c) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? (parsed.data as z.infer<S>) : reject(c, parsed.error, message);
  });
}

/** Query string, on the same terms as {@link paramZodValidator}. */
export function queryZodValidator<S extends z.ZodType>(schema: S, { message }: ErrorOptions = {}) {
  return validator('query', (value, c) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? (parsed.data as z.infer<S>) : reject(c, parsed.error, message);
  });
}
