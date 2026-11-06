# The impact report

Optimize time-to-understand. The first screen answers three things: what changes for the user,
the provisional decision with its main condition, and whether the public API breaks. Diff
statistics are supporting evidence, never the hero.

You do not write HTML. `cez impact render` composes the report from your model with cezar's own
template; this file tells you what the reader will see, so you can write a model that reads well.

## Design

- **cezar-native.** The report uses the cockpit's tokens: near-black surfaces and the lime accent
  in dark, white surfaces in light, violet for demo markers, the cockpit's status inks. It follows
  the viewer's system theme; the cockpit's Assets view passes `#theme=dark|light`.
- **No network.** One self-contained file with a strict CSP: no webfonts (system stacks; Inter
  when installed), no images from anywhere, no requests. Repository text is escaped and never
  executes.
- **Change semantics: colour plus a glyph, never colour alone.** `+ New` success green,
  `~ Changed` amber ink, `− Removed` danger red with dashed outlines and edges, `· Unchanged`
  soft. API changes add `↓ Deprecated`; breaking reads `✕ Breaking`, undecided `? Undecided`.
- **Credit.** The header and footer carry "Created by the Open Mercato Team" with a link to
  <https://github.com/open-mercato/open-mercato>.

## Composition

A sticky horizontal section bar (no sidebar) with scroll-spy: Overview · Capabilities ·
Architecture *n* · Public API · Flows · Trade-offs · Fit · Questions. Counts sit beside the
labels; Public API shows `N breaking` in red when there are any.

1. **Overview.** Subject, repository, comparison; the title and subtitle; the summary; three
   facts — Decision (label + first condition), For the user (the first capability), Public API
   (`N breaking changes` or `No breaking changes found`, plus undecided rows); then the
   recommendation with its evidence beside the numbered conditions (owner, verification, the API
   changes each one settles); then the scope note. Order your conditions and capabilities so the
   most important one comes first.
2. **Capabilities.** Cards in an auto-fill grid. Selecting one lights up its components in its
   home view; *Show in map N* jumps there.
3. **Architecture.** One numbered map per view, in model order: title, description, a
   Before/After/Compare switch, a board of HTML nodes with SVG edges (positions shared across
   states; absent components drawn as dashed placeholders), an inspector with the selected
   component's before/after, impact, relationships and the other maps that draw it, a caption,
   and the relationships as text.
4. **Public API.** A table grouped by surface, groups with breaking rows first and breaking rows
   first within each group; every row expands into before/after, impact, consumers, migration
   and evidence.
5. **Flows.** A scenario picker, before and after step diagrams side by side, then the outcome for
   the user and the failure behavior. Clicking a step selects its component in the map.
6. **Trade-offs, Fit, Questions.** Benefit/cost/alternative cards; fit rows with the rule and the
   assessment; questions with their owner and why they matter.
7. **Evidence inspector.** Every evidence chip opens one dialog (keyboard usable, Escape closes);
   *All evidence* lists everything with its kind.

## Spec mode

For `subject_kind: "spec"`, every Before/After label reads **Today/Proposed**, board headings
read *Today · in the code* and *Proposed · by the spec*, and absent components say *Not built
yet*.

## Asking about an element

Every condition, capability, node, edge, API row, flow, flow step, trade-off, fit row and question
carries its model id as `data-ref`. Inside the cockpit, clicking one (or its *Ask* tag) puts a
reference to it into the task's composer; the report never sends anything by itself. This is why
ids must be stable across revisions.

## Writing for the layout

- Node labels fit three short lines and kinds two; the full text is in the inspector.
- Edge labels are a few words ("emits key events", "reads SQL directly").
- Captions say what the reader should notice in that state.
- Prefer one honest board to three thin ones, and split a crowded one along a boundary.
