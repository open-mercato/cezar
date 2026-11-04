---
name: cezar-docs
description: Write or update pages of the Cezar documentation site (docs/site, Next.js + Fumadocs, MDX) following the Next.js docs conventions — file-system routing, required frontmatter, "Good to know" notes, related links, and the Next.js voice. Use when adding or changing a feature page, guide, or architecture page, when a code change alters user-visible behavior that a page describes, or when asked to preview or build the docs.
---

# Writing Cezar docs

The human-facing version of these rules is `docs/site/content/docs/05-contributing/01-docs-contribution-guide.mdx`
(served at `/docs/contributing/docs-contribution-guide`). It adapts the
[Next.js docs contribution guide](https://nextjs.org/docs/community/contribution-guide). If you change a rule, change
both files in the same commit.

## Workflow

1. **Find the page.** Pages live in `docs/site/content/docs`. URL = path without the `NN-` prefixes and `.mdx`:
   `03-features/git-and-github/worktrees.mdx` → `/docs/features/git-and-github/worktrees`. Feature pages are named by
   feature ID; grep for the feature's UI label or env var to find one.
2. **Read the code first.** Describe what the code on `main` does by default, not what a spec hopes for. Record what you
   read in `sources` (path, line, the commit SHA you read — `git rev-parse HEAD`).
3. **Write** using the template for the page type (below) and the voice rules.
4. **Check and build:**
   ```bash
   npm run docs:check   # links, related, images, CEZ_* vs .env.example, naming, style words, emojis, raw HTML
   npm run docs:build   # check + next build (fails on bad frontmatter or a dead related link)
   ```
   `npm run docs:dev` serves the site at http://localhost:4322/docs with hot reload. The site is NOT an npm workspace —
   these root scripts install `docs/site` on their own; the repo's `npm ci` never pulls Next.js.
5. A user-visible behavior change in `packages/` should update its feature page in the same PR.

## Structure rules

- File-system routing. `NN-` (two digits) prefixes order sections readers go through in order; reference folders
  (`03-features/<area>/`) have no prefixes and sort alphabetically.
- `meta.json` carries only `{ "title": "…" }`. Never add a `pages` array — file names are the order.
- File and folder names: lowercase kebab-case. A folder's own page is its `index.mdx`.
- Only `.mdx` and `meta.json` in `content/docs`. Images go in `docs/site/public/images/` (PNG, from a
  `CEZ_DRY_RUN=1` cockpit) and are referenced as `/images/name.png` with real alt text.

## Frontmatter

```yaml
---
title: Isolated worktrees            # required, a few words
description: One or two sentences.   # required, what the reader can do with the page
nav_title: Worktrees                 # optional, shorter sidebar label
version: opt-in                      # optional: opt-in | experimental | planned (omit when on by default)
related:                             # optional cards at the end; paths without /docs and without NN- prefixes
  links:
    - guides/parallel-tasks
sources:                             # files the page was checked against
  - label: Implementation
    path: packages/web/src/routes/new-task.tsx
    line: 877
    commit: 0355f9c9e46373c342dcb8a4d466df48e3f90d3e
---
```

- `version` follows Cezar's zero-config rule: what happens with nothing configured. A `CEZ_*`/setting that must be
  turned ON → `opt-in`. Only a spec in `.ai/specs/` → `planned`, and that spec must be in `sources`.
- Every `CEZ_*` variable a page names must exist in `.env.example` (the check enforces it). If it is missing, the bug is
  in `.env.example` — fix it there (AGENTS.md § Zero config), do not drop it from the page.
- Example shell variables in code blocks must not use the `CEZ_` prefix (use `CEZAR_URL`, `PROJECT_ID`).

## Page templates

- **Feature** (`03-features/<area>/<id>.mdx`): overview paragraph → `## Where to find it` (menu path with `→`, or the
  command) → `## How to use it` (≤ 3 numbered steps) → `> **Good to know**:` defaults, limits, how to turn it off.
  Planned features use `## Status` and `## What you can do today`.
- **Guide** (`02-guides/*.mdx`, `01-getting-started/*.mdx`): what the reader has at the end → `## Prerequisites` →
  `## Step N: Verb phrase` each ending with `**Check**: …` → `## How it works` → `## Troubleshooting` (one `###` per
  problem).
- **Architecture** (`04-architecture/NN-*.mdx`): one `##` per concept, each backed by a table, command, or code block.
- New area index pages (`index.mdx`) list their children with `<Cards>`/`<Card>`, or a table for reference sections.

## MDX and components

- Allowed components: `<Cards>`, `<Card>`, `<Mermaid chart={\`…\`} />`, plus `<details>`/`<summary>`. No other raw HTML.
  A new component goes in `docs/site/components/mdx.tsx` AND the contribution guide.
- `{`, `}`, `<` are MDX syntax: put code, paths, env vars, placeholders (`<projectId>`) in backticks.
- Code blocks: a language always; `title="Terminal"` for shell, `title="<file path>"` for files, `txt` +
  `title="Example task"` for prompts. Minimal and runnable as copied; commands use `npx cezar-run`.
- Highlight a line with a trailing `// [!code highlight]` (or `# [!code highlight]` in YAML/bash).
- Notes: `> **Good to know**: …` (single line) or `> **Good to know**:` + `>` + `> - item` lines.
- In-body links use the full path: `[HTTP API](/docs/architecture/http-api)`.
- No emojis anywhere.

## Voice (Next.js)

- Second person (*you*), active voice, short sentences; split comma-heavy sentences or use a list.
- Plain words (*use*, not *utilize*). Never *easy, simple, simply, just, quick, obviously* — the check rejects them
  outside code (italicized mentions are allowed when discussing the words themselves).
- Prefer positive instructions over *don't / can't / won't*.
- Repeat the subject instead of an ambiguous *this*.
- Gender-neutral: *developers*, *users*, *readers*; they/them.
- UI labels exactly as the cockpit shows them; menu paths with `→`.
- Conceptual pages (guides) instruct; reference pages (features, architecture) state facts with direct verbs.

## Before you finish

- [ ] `npm run docs:check` passes, and `npm run docs:build` passes when you touched frontmatter, components, or app code.
- [ ] Every behavior claim is traceable to a `sources` entry at the commit you read.
- [ ] `version` matches the zero-config default.
- [ ] New pages have `related` links to the logical next step.
