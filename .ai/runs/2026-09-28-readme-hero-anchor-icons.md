# Run: README hero without permalink anchor icons

## Goal

Stop the chain-link permalink icons from appearing next to the README hero (title, nav
row, tagline) on mobile GitHub, so the top of the page reads like the READMEs of
comparable projects.

## Context

GitHub's rendering pipeline wraps **every** heading element — including raw-HTML
`<h1>`/`<h2>`/`<h4>` written by hand — in `<div class="markdown-heading">` and appends an
`<a class="anchor">` permalink carrying the `octicon-link` SVG. Verified against the live
rendering:

```
gh api repos/open-mercato/cezar/readme -H 'Accept: application/vnd.github.html+json'
→ <div class="markdown-heading"><h1 class="heading-element">Cezar - orchestrate …</h1>
  <a id="user-content-cezar---…" class="anchor" …><svg class="octicon octicon-link" …>
```

On desktop the icon is hover-only; on touch devices GitHub shows it permanently, which is
what the screenshot in the report shows — three icons, one per hero heading (h1 title, h4
nav row, h2 tagline). Sibling `<p align="center">` blocks (the language switcher) get no
anchor.

The hero headings are decorative: nothing links to them, and they exist only for size and
centering. Section headings (`## Features`, `## Quick start`, …) stay headings — they are
real anchors, the nav row links to `#quick-start`, and their permalink icons are expected.

## Scope

- `README.md`, `README.zh-CN.md`, `README.zh-TW.md` — hero block only.
- Replace the three decorative headings with centered paragraphs; restore the lost visual
  weight of the `<h1>` with the existing brand icon (`docs/brand/cezar-icon-violet.svg`),
  the pattern used by comparable project READMEs (logo image + centered paragraphs).

## Non-goals

- No changes to section headings or their anchors.
- No new brand assets (the brand guidelines say logo files are generated from one script).
- No copy rewrites, no restructuring below the hero.

## Risks

- Losing the `<h1>` removes the document-level heading. Low impact: GitHub renders the
  repository name above the README, the title stays as real text (screen readers, npm,
  search engines still get it), and the alternative — keeping a heading — is the defect.
- Docs-only change: the repository has no markdown lint, so verification is a re-read of
  the diff plus the GitHub-rendered HTML of the pushed branch (assert no `octicon-link`
  before the first section heading).

## Progress

PR: #1130

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: English README

- [x] 1.1 Replace the hero headings in README.md with centered paragraphs plus brand icon — 01259781

### Phase 2: Localized READMEs

- [x] 2.1 Mirror the hero structure in README.zh-CN.md — 86a8d5bb
- [x] 2.2 Mirror the hero structure in README.zh-TW.md — 86a8d5bb

### Phase 3: Verification

- [x] 3.1 Verify the GitHub-rendered branch README has no permalink icon in the hero and the `#quick-start` nav link still resolves — 86a8d5bb
