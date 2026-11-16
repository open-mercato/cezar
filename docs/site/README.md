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

## Mobile privacy policy deployment

The mobile apps and store listings link to **https://cezar.run/mobile/privacy**. The source is
`packages/mobile/store/privacy-policy.md`, with a standalone HTML renderer in the same package.
This static site can carry the approved page, but no cezar.run production deployment configuration
is present here. Confirm who deploys that domain and whether it serves this site's export before
using these steps. Building this site alone does not publish the policy.

After the owner has resolved every `OPEN MERCATO TO CONFIRM` fact, run from the repository root:

```bash
node packages/mobile/store/scripts/render-privacy.mjs --final
```

Stop if this fails. It refuses unfinished legal facts; never copy a draft into `public/`. Only after
it succeeds, stage the approved HTML and build the static site:

```bash
mkdir -p docs/site/public/mobile/privacy
cp packages/mobile/store/privacy-policy.html docs/site/public/mobile/privacy/index.html
npm run docs:build
cmp packages/mobile/store/privacy-policy.html docs/site/out/mobile/privacy/index.html
```

The staged `public/mobile/privacy/` directory is generated and ignored by git. Repeat the final
render and copy whenever the policy changes. It is deliberately absent from normal docs builds
until approved text is staged, so an ordinary build cannot publish the draft accidentally.

The deployment owner must serve `/mobile/privacy` as `text/html` from
`out/mobile/privacy/index.html`, or redirect it to `/mobile/privacy/` and serve that index there.
Neither path may require authentication or fall through to a landing page/404. If cezar.run uses a
different landing-site deployment, give that owner the same approved standalone HTML and route
requirement instead of deploying this entire docs site. After the authorized deployment, verify:

```bash
curl --fail --location --max-time 30 https://cezar.run/mobile/privacy -o /tmp/cezar-mobile-privacy.html
cmp packages/mobile/store/privacy-policy.html /tmp/cezar-mobile-privacy.html
```

The response must contain the approved policy with no highlighted facts or draft banner. A local
build or a successful request for some other page is not proof that the mobile policy URL works.
`RELEASING-MOBILE.md` lists the remaining legal, provider and store-submission requirements.

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
