# Execution plan — README website pill

## 🎯 Goal

Give the README badge row a website pill linking to <https://cezar.run/>, so a
reader landing on the repo page can reach the project site without hunting for
it in prose.

## Scope

- `README.md` — badge row only: add a shields.io website pill.
- `README.zh-CN.md`, `README.zh-TW.md` — mirror the same pill with a localized
  `alt` text, keeping the three hero blocks structurally identical (the
  convention every recent README run has followed).

### Non-goals

- No change to the nav line (Demo · Quick start · Docs · Issues), the hero
  headings, the cloud banner, or any prose section.
- No new website content, no docs page about the site, no link checker.
- No reordering or restyling of the existing license / npm / node / PRs pills.

## Decisions taken

- **Pill, not nav link.** The brief asks for a "site pill"; the badge row is the
  repo's pill row, so the website goes there rather than into the `·`-separated
  nav line.
- **First in the row.** The website is the most useful destination for a new
  reader, so it leads the row ahead of the license badge.
- **Brand violet `#9655FD`** as the badge colour, taken from `docs/brand/README.md`
  ("Brand violet | `#9655FD` | violet mark, brand blocks"), so the pill reads as
  the project's own rather than a generic shields default.
- **Label `website` / message `cezar.run`** — the hostname is the recognisable
  part, and it tells the reader where the click goes before they click.

## Implementation Plan

### Phase 1: Add the pill to the three READMEs

- 1.1 Add the website pill to the `README.md` badge row.
- 1.2 Mirror it in `README.zh-CN.md` with localized `alt` text.
- 1.3 Mirror it in `README.zh-TW.md` with localized `alt` text.

### Phase 2: Verify and ship

- 2.1 Re-read the rendered diff, confirm the three hero blocks stay in sync and
  the badge URL resolves, then run the applicable validation.

## Risks

- **Low.** Docs-only, three markdown files, no runtime code path touched.
- The repo has no markdown linter, so the docs gate is a manual diff re-read
  plus a check that the badge and target URLs actually resolve; this is recorded
  as the gate's limit rather than skipped silently.
- `https://cezar.run/` is operator-supplied; if the site later moves, the pill is
  a one-line edit in three files.

## Progress

PR: #1145

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Add the pill to the three READMEs

- [x] 1.1 Add the website pill to the `README.md` badge row — 0c82c07a
- [x] 1.2 Mirror it in `README.zh-CN.md` with localized alt text — 0c82c07a
- [x] 1.3 Mirror it in `README.zh-TW.md` with localized alt text — 0c82c07a

### Phase 2: Verify and ship

- [x] 2.1 Re-read the diff, confirm hero parity and that the URLs resolve — 0c82c07a

Verification evidence for 2.1:

- `https://cezar.run/` → `200`, no redirect; `https://img.shields.io/badge/website-cezar.run-9655FD` → `200 image/svg+xml`.
- Branch README rendered through GitHub's own markdown pipeline
  (`gh api "repos/open-mercato/cezar/readme?ref=feat/readme-site-pill" -H "Accept: application/vnd.github.html"`):
  the pill renders as the first anchor of the badge row, camo-proxied exactly
  like the existing license/npm badges, and the camo URL itself returns
  `200 image/svg+xml`.
- Diff is 6 added lines across the 3 READMEs and nothing else; the three hero
  blocks stay structurally identical.
- No test reads the repository README — every `README.md` occurrence under
  `packages/**/*.test.*` is a string literal or diff fixture — so the code gate
  cannot be affected by this change.
