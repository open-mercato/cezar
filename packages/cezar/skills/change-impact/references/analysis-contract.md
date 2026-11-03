# Review model v4

Write a JSON object shaped like cezar's demo model (`cez impact render --demo` renders it), but
never copy its fictional conclusions into a real review. `cez impact render` validates the shape,
every id and reference, the statuses, the graph and the mandatory sections, and prints each
problem as `path: message`. Unknown keys are refused, so a misspelt key comes back as an issue.

## Context and provenance

Set `schema_version` to `4`. `meta` holds `title`, `subtitle`, `repository`, `pr`, `base`,
`head`, boolean `demo`, and `subject_kind` (`"pr"` or `"spec"`). `pr` is the subject's label:
`PR #123 · title`, or the spec path. Use exact SHAs for `base` and `head` (for a spec: the
commit and the spec's blob SHA). `summary` is a concise product-level explanation. `scope_note`
says what was not assessed.

`decision` holds `label`, `rationale`, `evidence` and `conditions`. Each condition has `id`,
`title`, `owner` (a role), `verification` (what clears it), `evidence`, and optional
`api_changes`: the ids of the API changes this condition settles. A recommendation is a
human-reviewed judgment, never a mechanical merge authorization.

Each evidence record has a unique `id`, `kind` (`observed`, `inferred`, `unknown`, `demo`),
`title`, `source` and `detail`; an optional `url` must be credential-free `https`. Use a base/head
path and line, or an exact command with its exit status, SHA and timestamp. `source` alone is a
locator, not proof; read the source first. Never label a synthetic example `observed`, and never
attach a confidence percentage. `demo` evidence is only allowed when `meta.demo` is true.

## Ids

Every element the report lets the user point at carries an `id`: conditions, capabilities,
nodes, edges, flows, trade-offs, fit rows, questions and API changes. These ids are unique
**across the whole model** (evidence ids and view ids are their own namespaces; flow step ids
only need to be unique within their diagram). Keep ids stable when you revise a model, so a
correction can be traced.

## Product delta

`capabilities`: `id`, `status` (`added`, `modified`, `removed`), `title`, `before`, `after`,
`impact`, `components` (node ids) and `evidence`. Describe a user-visible capability, not an
implementation file. `home_view` is computed by the renderer; do not write it.

## Architecture

`architecture`: `headline`, `description`, `nodes`, `edges`, `views`. The headline and
description introduce the whole architecture story; each view carries its own heading and
captions.

Nodes have `id`, `label`, `kind`, `status` (`added`, `modified`, `removed`, `unchanged`),
`before`, `after`, `impact` and `evidence`. A node is described once, however many views draw it.
`before` and `after` explain responsibility, not mere presence. `kind` states the abstraction
(module, service, UI, integration); do not imply that every module is deployed on its own.

Edges have `id`, `from`, `to`, `label`, `status` and `evidence`. An arrow states a directed
relationship: HTTPS request, reads, writes, emits, calls, static import. A `modified` edge also
has `before_label`, and the same endpoints must carry a real semantic change; when endpoints move,
use two edges (one removed, one added). An edge cannot exist in a state where one of its
endpoints does not. No self-edges. Import relationships are not runtime traces. Observed indirect
impact should name the exact relationship chain; an uncertain blast radius stays inferred.

### Views: how many diagrams the change needs

`views` is a list of 1–8 diagram sections. Each becomes its own numbered map with its own
before/after/compare board and inspector.

Each view has `id`, `title`, `description`, `before_caption`, `after_caption`, an optional
`focus`, and `places`: a list of `{node, col (0..2), row (0..9)}`. A view holds 2–12 components;
5–9 read best. Positions are shared by the before and after state of that view, and no two
components may share a cell. A node may be placed in several views.

Choose the split by what has to be explained, not by file count:

- One view when the change stays inside one boundary.
- Two to four views for a large change: the runtime path, then data ownership and tenancy, then
  the extension points third parties see; or one view per bounded context.
- Split a board when it would exceed about nine components, mix relationships of different kinds
  (runtime calls, data ownership, deployment) on one canvas, or serve two audiences.
- Every view needs its own reason to exist, stated in its description.

The renderer enforces: every node is placed in at least one view; both endpoints of every edge
are placed together in at least one view; every capability's components fit inside one view (its
home view); `focus` names a component placed in that view.

## Public API delta

`api_changes`: a list, empty when the change touches no public surface (the report then says
*No breaking changes found*). Each entry:

| Field | |
|---|---|
| `id` | unique, model-wide |
| `surface` | `http`, `export`, `event`, `cli`, `config`, `schema`, `extension-point`, `other` |
| `name` | `POST /store-api/checkout/cart/line-item`, `CheckoutOrderPlacedEvent`, `export function foo`, `--trunk` |
| `status` | `added`, `modified`, `removed`, `deprecated` |
| `breaking` | `true`, `false`, or `"unknown"` when you could not decide |
| `impact` | why it breaks; required when `breaking` is `true`, and when a `removed` surface is not marked breaking (say why removing it is safe) |
| `before`, `after` | the signature or shape, short (omit the side that does not exist) |
| `consumers` | who is known to depend on it: node ids or free text |
| `migration` | what a consumer must do; required when `breaking` is `true` |
| `evidence` | evidence ids; a breaking change needs at least one `observed` record (`demo` counts only in a demo) |

**Linking breaking changes to the decision.** Every `breaking: true` change must be listed in
the `api_changes` array of at least one `decision.conditions` entry: the condition that says who
clears it and how (a major version, a BC layer, a migration window). The renderer refuses a model
where a breaking change is not named by any condition, or where a condition names an id that does
not exist.

```json
"conditions": [
  { "id": "cond-migration", "title": "Migration without cutting anyone off", "owner": "Product owner",
    "verification": "An agreed transition period and a message to customers.",
    "evidence": ["E5"], "api_changes": ["api-personal-tokens"] }
]
```

## Behavior and judgment

`flows`: `id`, `title`, `before`, `after`, `outcome`, `failure`, `evidence`. Each `before`/`after`
has `steps` (`id`, `label`, `component` node id, `status`) and `links` (`from` step id, `to` step
id, `label`). A step may not reference a component that does not exist in that state. Represent
decisions and loops with links; never silently flatten them. Distinguish an inferred runtime flow
from an executed trace.

`tradeoffs`: `id`, `title`, `pro`, `con`, `alternative`, `evidence`: a paired benefit and cost
and a feasible alternative, not generic best practice.

`fit`: `id`, `title`, `status` (`aligned`, `tension`, `unknown`), `rule`, `assessment`,
`evidence`. Include at least one product criterion and one architecture criterion. Cite the actual
ADR, convention or roadmap; say unknown when it is absent. Address whether the feature belongs in
core or in an optional integration.

`questions`: `id`, `owner`, `question`, `why`, `evidence`. Questions carry uncertainty; do not
invent a decision from missing product strategy, integration tests, runtime behavior or SLOs.

`capabilities`, `flows`, `fit` and `evidence` cannot be empty; `tradeoffs`, `questions` and
`api_changes` may be.

## Minimum acceptance

A real review includes a product delta, relationship evidence and an honest public API section.
Every claim, node/edge/flow mapping, API change and decision carries evidence ids. When context is
missing, add explicit `unknown` evidence and say so; never deliver a polished fictional
conclusion. An honest partial analysis beats inferred certainty.
