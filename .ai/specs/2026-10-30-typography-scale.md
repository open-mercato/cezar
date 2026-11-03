# Typography — one scale, one eyebrow, one face per row

Status: implemented (2026-10-30), on `feat/first-run-onboarding` (#1725). Tokens and the
`eyebrow` utility in `packages/web/src/styles/index.css`; `cn` taught the scale in
`packages/web/src/lib/utils.ts`; two guardian rules in `packages/web/src/design-guardian.test.ts`.

## Audit

The cockpit sets three typefaces, all vendored under `packages/web/src/assets/fonts` (latin +
latin-ext, `font-display: swap`, no font service): **Inter Variable** for everything that is
read, **JetBrains Mono Variable** for `code`/`pre`/`kbd`/`samp`, identifiers (hashes, issue
numbers, branches, versions), times and counts (`tabular-nums`), shortcuts, commands and the
terminal, and **Chakra Petch 600** for the five letters of the wordmark. The desktop shell's own
page uses the same two stacks; its native title-bar chip, the server's "cockpit isn't built"
page and the dashboard's PDF footer use `system-ui`, because none of them has the font files.
The docs site vendors the same Inter and JetBrains Mono separately.

The families were in order. What was not:

- **Fifteen arbitrary pixel sizes** beside the eight named ones, with half-pixel steps used
  interchangeably for the same role: a meta line was 10.5, 11, 11.5 or 12px depending on the
  file. 13px (272 uses) and 11px (243) were the real scale; 12.5, 11.5, 10.5 and 13.5 were drift.
- **Three styles of eyebrow** — the small capitals over a section, a table column or a card:
  sans 11px semibold `tracking-[.05em]` (automations), mono 11px `tracking-[0.12em]`
  (dashboard), sans 11px `tracking-wide` without weight (onboarding), with nine distinct
  `tracking-*` values in all.
- **Four faces in one pill row.** The composer's source pill set a picked skill in mono and
  semibold, the base-branch pill in mono, the project pill in semibold, the rest plain — the
  same row read as four typefaces, on `/new`, in a task's thread and in the automation editor.

## Decisions

**The scale.** Six steps below `text-base`, one pixel apart, as `--text-*` tokens in
`@theme static`, font-size only (line-height stays inherited, exactly as the arbitrary sizes
they replace left it):

| token | px | was |
| --- | --- | --- |
| `text-micro` | 10 | 10, 10.5 |
| `text-meta` | 11 | 11, 11.5 |
| `text-label` | 12 | 12, 12.5 |
| `text-ui` | 13 | 13, 13.5 |
| `text-body` | 14 | 14, 14.5 |
| `text-lead` | 15 | 15 |

`text-xs` (12 with its line-height) and `text-sm` (14) stay in use beside them; the named
sizes above `base` are untouched. Nothing under 10px is type — the 7–9px labels inside the
onboarding miniatures are drawing — and stays arbitrary. `cn()` is told the six are font sizes:
`tailwind-merge` otherwise reads `text-ui` as a text colour and drops either it or the colour
next to it, which the full suite caught on the Button variants.

**The eyebrow.** One `@utility eyebrow`: 11px, 600, `0.05em`, uppercase. The colour is the
caller's — `text-soft-foreground` as a rule, `text-muted-foreground` where the surface is
darker, `text-violet` on an onboarding surface. Forty files moved onto it; what remains
uppercase without it is avatar initials, a badge, a picture label and the print stylesheet.

**One face per row.** The pill row's typeface and weight are set at the source — `Chip`'s
`skill` state, `SourcePill`, the project and base-branch pills — not by a per-surface
override: the composer in a task thread is the same control as the composer on `/new`. Mono
remains the face for identifiers everywhere else.

**Two guardian rules** keep it so: `no-arbitrary-type-sizes` (a `text-[Npx]` at 10px or
above outside `index.css`) and `no-ad-hoc-eyebrow` (`uppercase` and `tracking-*` in one
class string).

## Not done

- The weight contrast between the onboarding surfaces (light titles) and the rest of the
  cockpit (semibold headers) is deliberate (spec 2026-10-26-first-run-onboarding § Layout) and
  stays.
- Line-heights are still a mix of inherited and named values; a line-height scale would be the
  next audit.
