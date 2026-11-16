# Cezar documentation site

The Cezar user documentation as a Next.js app ([Fumadocs](https://fumadocs.dev)): MDX pages in
`content/docs`, full-text search, diagrams, and an `llms.txt` index for agents.

The site has its own `package.json` and is **not** an npm workspace, so the repository's `npm ci`
never downloads Next.js. The root scripts install it on demand.

## Run it

From the repository root:

```bash
npm run docs:dev     # http://localhost:4322/docs, reloads as you edit
npm run docs:check   # content checks only: links, frontmatter, images, CEZ_* vars, style
npm run docs:build   # checks, then a static export to docs/site/out/
npm --prefix docs/site start   # serve the built out/ folder on port 4322
```

`out/` is plain HTML, CSS, and JavaScript. Host it on any static file server; search runs in the
browser from a prebuilt index.

## Mobile privacy policy

The mobile app, store listings and existing relay terms setup use
**https://openmercatocloud.com/privacy**. That externally hosted Open Mercato policy is the public
destination; this docs site does not need to deploy a mobile policy page or rewrite its legal text.

`packages/mobile/store/privacy-policy.md` and its generated HTML are internal technical review
drafts with explicitly unconfirmed facts. Do not stage them under `public/` or publish them as a
replacement for the existing policy. See `RELEASING-MOBILE.md` for URL verification and the
remaining store-submission requirements.

## Layout

| Path | What it is |
| --- | --- |
| `content/docs/` | The pages. File-system routing: `01-getting-started/02-first-task.mdx` → `/docs/getting-started/first-task`. |
| `public/images/` | Screenshots used by pages. |
| `lib/schema.ts` | The frontmatter contract (`title`, `description`, `nav_title`, `version`, `related`, `sources`). |
| `lib/source.ts` | Loads the pages; strips `NN-` order prefixes from URLs; applies `nav_title`. |
| `components/` | The MDX components pages may use (`Cards`, `Card`, `Mermaid`) and the page extras (version badge, related cards, sources). |
| `scripts/check.mjs` | Checks the build cannot make. |

## Writing pages

Read the [docs contribution guide](content/docs/05-contributing/01-docs-contribution-guide.mdx).
It adapts the [Next.js docs contribution guide](https://nextjs.org/docs/community/contribution-guide).
Coding agents get the same rules from the `cezar-docs` skill (`.ai/skills/cezar-docs/SKILL.md`).

## Assets

Inter and JetBrains Mono are self-hosted in `app/fonts/`, with their licenses, so a build needs no
font CDN. Product screenshots come from this repository.
