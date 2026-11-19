# The impact report

Optimize time-to-understand. The first screen answers three things: what changes for the user,
the provisional decision with its main condition, and whether the public API breaks. Diff
statistics are supporting evidence, never the hero.

You do not write HTML. `cez impact render` composes the report from your model with cezar's own
template; this file tells you what the reader will see, so you can write a model that reads well.

## Design

- **cezar-native, calm.** The report uses the cockpit's tokens on an off-white (light) or
  near-black (dark) page with raised cards, the lime accent for focus and navigation only, violet
  for demo and revision markers. It follows the viewer's system theme; the cockpit's Assets view
  passes `#theme=dark|light`. Every text colour meets WCAG AA on its surface.
- **No network.** One self-contained file with a strict CSP: no webfonts (system stacks; Inter
  when installed), no images from anywhere, no relative paths, no requests. Repository text is
  escaped and never executes.
- **Readable.** 16 px body text, prose held to about 68 characters a line, sentence-case labels.
  Text in backticks (`` `string | null` ``) renders as code, so use backticks for identifiers,
  types and commands, and only for those. Commit SHAs show as 7 characters.
- **Change semantics: colour plus a glyph, never colour alone.** `+ New` success green,
  `~ Changed` amber ink, `− Removed` danger red with dashed outlines and edges, `· Unchanged`
  soft. API changes add `↓ Deprecated`; breaking reads `✕ Breaking`, undecided `? Undecided`.
- **The verdict has a tone**, read from the words of `decision.label`: approve → ✓ green;
  comments, conditions or a direction → ! amber; request changes, reject, block or a negated
  approve (`Do not approve`, `Not mergeable`) → ✕ red;
  anything else neutral. Write a label that says which one it is.
- **Phone and print.** At phone width everything stacks into one column. Print uses light ink,
  opens every Public API panel, prints evidence chips as `[E1]` and appends every source.
- **Credit.** The header and footer carry "Created by the Open Mercato Team" with a link to
  <https://github.com/open-mercato/open-mercato>.

## Composition

A sticky, floating section bar (no sidebar) with scroll-spy: Overview · Capabilities ·
Architecture *n* · Public API · Flows · Trade-offs · Fit · Questions. Counts sit beside the
labels; Public API shows `N breaking` in red when there are any.

1. **Overview.** Subject, repository and comparison; the title and subtitle; then three fact
   cards: Decision (the verdict with its tone, the number of conditions and the first one), For the
   user (the first capability) and Public API (`N breaking changes` with their names, or `No
   breaking changes found`, plus undecided rows). Then the recommendation with its evidence beside
   **Before merging**, the numbered conditions (owner, verification, the API changes each one
   settles, as links to them); then *What the change does* (the summary) and the scope note. Order
   your conditions and capabilities so the most important one comes first.
2. **Capabilities.** Cards in an auto-fill grid. Selecting one lights up its components in its
   home view; *Show in map N* jumps there.
3. **Architecture.** One numbered map per view, in model order: title, description, a
   Before/After/Compare switch, a board of HTML nodes with SVG edges (positions shared across
   states; absent components drawn as dashed placeholders), an inspector with the selected
   component's before/after, impact, relationships and the other maps that draw it, a caption,
   and the relationships as text.
4. **Public API.** One card per change, grouped by surface, breaking first. Each card says
   *What breaks* (impact) and who is affected (consumers), and *What to do*: the condition(s) that
   name this change in `api_changes`, as **Before merge** steps with their owner; the `migration`
   as **Consumers must**; *Decide whether this breaks* for an undecided row; *No action* when
   there is nothing. *Copy as review comment* copies the card as Markdown. The before/after
   signatures and the evidence fold away; a `before`/`after` written as `a: T; b: U` is shown one
   member per line, so write signatures that way and prose with backticks.
5. **Flows.** A scenario picker, before and after step diagrams side by side, then the outcome for
   the user and the failure behavior. Clicking a step selects its component in the map.
6. **Trade-offs, Fit, Questions.** Benefit/cost/alternative cards; fit rows with the rule and the
   assessment; questions with their owner and why they matter.
7. **Evidence.** Every chip shows its kind (● read in the source, ◯ inferred, ◆ not known);
   hovering or focusing it previews the title and source, and clicking opens the full entry in one
   dialog (keyboard usable, Escape closes). *All evidence* lists everything with its kind.

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
