/** The `/new` deep-link contract the saved bookmarklets rely on (spec 011,
 *  protected by BACKWARD_COMPATIBILITY.md): `?skill=&ref=&auto=1&key=`.
 *
 *  Parsing lives apart from the component so it stays table-testable and so the
 *  real composer (Step R4) can consume the same shape without re-deriving it.
 *  Kept byte-for-byte compatible with `initFromQuery()` in web/app.js: `ref`
 *  falls back to the older `task` spelling, `auto` is the exact string `1`.
 */
export interface NewTaskParams {
  skill: string
  ref: string
  auto: boolean
  key: string
  /** The inbox entry this prefill came from (#374), when any — the composer sends it back as
   *  `todoId` on POST /api/runs so the started task is recorded on the entry. NOT part of the
   *  bookmarklet contract: saved links never carry it, and it is inert on its own. */
  todo: string
}

export function parseNewTaskParams(search: string | URLSearchParams): NewTaskParams {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  return {
    skill: (params.get('skill') ?? '').trim(),
    ref: (params.get('ref') ?? params.get('task') ?? '').trim(),
    auto: params.get('auto') === '1',
    key: params.get('key') ?? '',
    todo: (params.get('todo') ?? '').trim(),
  }
}

/**
 * Build a same-origin `/new` href from this contract — the counterpart to `parseNewTaskParams`
 * for in-app callers (e.g. the Inbox's "Run", #374). Deliberately never sets `auto`/`key`:
 * those arm the bookmarklet's unattended start, but an in-app link always lands on the
 * editable composer so the user can review before launching.
 *
 * `todo` is the audit-trail half of that detour: it names the inbox entry the prefill came
 * from and rides back to the server as `todoId` when the user presses Start. It carries no
 * authority of its own — it neither arms `auto` nor stands in for `key`, so a `todo` link is
 * exactly as unattended-proof as a plain prefill.
 */
export function newTaskPrefillHref(params: { skill?: string; ref?: string; todo?: string }): string {
  const search = new URLSearchParams()
  if (params.skill) search.set('skill', params.skill)
  if (params.ref) search.set('ref', params.ref)
  if (params.todo) search.set('todo', params.todo)
  const qs = search.toString()
  return qs ? `/new?${qs}` : '/new'
}
