# Run: README hero back on headings, black brand icon

## Goal

Follow-up to #1130. Two asks: the hero icon should be the black tile with the white mark
rather than the violet one, and the headline and description should be bigger than they
ended up after #1130 removed the hero's headings.

**Direction decided by the owner mid-run**: do it with headings, the way
[conductor-oss/conductor](https://github.com/conductor-oss/conductor) does — not with the
drawn-text approach this run first shipped.

## Context

#1130 removed the hero's decorative headings because GitHub appends a permalink anchor —
the chain octicon, permanently visible on touch devices — to every heading element, raw
HTML included. That killed the icons but dropped the hero text to body size, because the
headings were also what made it big.

Probe commits on the previous branch established that GitHub allows exactly one way to
enlarge text, and it is a heading:

| markup | rendered as |
| --- | --- |
| `<font size="6">` | tag stripped, text left at body size |
| `<span style="font-size: 32px">` | `style` attribute stripped |
| `<big>` | tag stripped |
| heading in a table cell / blockquote / `<details>` | still wrapped + anchored |
| heading with an explicit `id` | still anchored (its own generated id) |
| heading containing only an `<img>` | still anchored, with a **broken** `id=""` / `href="#"` |

This run first took the other branch of that fork — drawing the headline and description
into generated SVGs — which kept the hero anchor-free at the cost of live text. The owner
chose the trade the other way: keep real text and accept the permalink icons.

That is also what the comparison repository actually does. `conductor-oss/conductor`'s
README renders 16 headings and **16 permalink anchors**, its hero being a logo `<picture>`
followed by `<h1 align="center">` and a `####` tagline. It does not avoid the icons; they
simply are not drawn by the GitHub mobile app, only by mobile browsers.

The icon question needs no judgement: `docs/brand/README.md` lists `cezar-icon-black.svg`
(black tile, white mark, 21:1) as the "main icon: app, favicon, avatars, GitHub", and the
violet one as an avatar/social variant.

## Scope

- `README.md`, `README.zh-CN.md`, `README.zh-TW.md` — hero block only:
  - icon → `docs/brand/cezar-icon-black.svg`, 104 px;
  - headline → `<h1>` again;
  - description → `<h2>` again.
- Net effect on the hero: the pre-#1130 structure, with the black icon added on top.

## Non-goals

- The nav row and the language switcher stay paragraphs. They were `<h4>`/`<p>` before and
  a heading buys them no size — only another permalink icon.
- No copy changes.
- No generated assets, no generator script, no CI step: all removed with the drawn-text
  approach they existed for. `.github/workflows/ci.yml` is byte-identical to `main` again.

## Risks

- **The permalink icons come back in the hero** — on `<h1>` and `<h2>`, visible in mobile
  browsers, invisible in the GitHub app. This is the accepted trade, not an oversight.
- Section headings and their anchors are untouched, so `#quick-start` and the Chinese nav
  anchors keep resolving.

## Progress

PR: #1131

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Direction

- [x] 1.1 Probe what GitHub's sanitizer allows for sizing — b009c80b
- [x] 1.2 Check how conductor-oss/conductor builds its hero (16 headings, 16 anchors) — 2064eb37
- [x] 1.3 Drop the drawn-text approach: remove `docs/hero/`, the generator and its CI step — 2064eb37

### Phase 2: READMEs

- [x] 2.1 Black brand icon in all three READMEs — 2064eb37
- [x] 2.2 Headline back to `<h1>`, description back to `<h2>`, in all three READMEs — 2064eb37

### Phase 3: Verification

- [x] 3.1 Verify the rendered branch README: headings anchored as expected, nav anchors resolve, no dangling references to the removed assets — 2064eb37
- [ ] 3.2 Human QA: open the branch README on a phone and in dark mode
