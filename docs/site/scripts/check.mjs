// Content checks the Next.js build cannot make: internal links, images, file naming,
// env vars against .env.example, and the style rules in the docs contribution guide.
// Usage: node scripts/check.mjs   (exit 1 on any error)
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(site, '../..');
const contentRoot = join(site, 'content/docs');
const errors = [];
const fail = (file, message) => errors.push(`${relative(site, file)}: ${message}`);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const stripPrefix = (segment) => segment.replace(/^\d{2}-/, '');
function slugOf(file) {
  const parts = relative(contentRoot, file).replace(/\.mdx$/, '').split(sep).map(stripPrefix);
  if (parts.at(-1) === 'index') parts.pop();
  return parts.join('/');
}

const files = walk(contentRoot);
const pages = files.filter((file) => file.endsWith('.mdx'));
const slugs = new Set(pages.map(slugOf));
const envExample = readFileSync(join(repo, '.env.example'), 'utf8');

// Prose only: drop fenced code, inline code, and URLs before the style checks.
const prose = (body) =>
  body
    .replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '')
    .replace(/<Mermaid chart=\{[\s\S]*?\}\s*\/>/g, '<Mermaid />')
    .replace(/`[^`\n]+`/g, '')
    .replace(/\]\([^)]*\)/g, ']()');

const STYLE_WORDS = /(?<![*\w-])(easy|easily|simple|simply|just|quick|quickly|obviously|utilize)(?![*\w-])/gi;
const EMOJI = /\p{Extended_Pictographic}/u;
const ALLOWED_TAGS = new Set(['Cards', 'Card', 'Mermaid', 'details', 'summary']);

for (const file of files) {
  const name = relative(contentRoot, file);
  for (const segment of name.split(sep)) {
    if (!/^(\d{2}-)?[a-z0-9]+(-[a-z0-9]+)*(\.mdx|\.json)?$/.test(segment))
      fail(file, `"${segment}" must be lowercase kebab-case, optionally with a two-digit prefix`);
  }
  if (file.endsWith('meta.json')) {
    const meta = JSON.parse(readFileSync(file, 'utf8'));
    if (!meta.title) fail(file, 'meta.json needs a title');
    if (meta.pages) fail(file, 'meta.json must not list pages; file names set the order');
  } else if (!file.endsWith('.mdx')) {
    fail(file, 'only .mdx pages and meta.json files belong in content/docs');
  }
}

for (const file of pages) {
  const text = readFileSync(file, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) {
    fail(file, 'missing frontmatter');
    continue;
  }
  const data = parseYaml(match[1]);
  const body = text.slice(match[0].length);
  if (!data.title) fail(file, 'missing title');
  if (!data.description) fail(file, 'missing description');

  for (const link of data.related?.links ?? []) {
    if (!slugs.has(link)) fail(file, `related link "${link}" names no page`);
  }
  for (const ref of data.sources ?? []) {
    if (!existsSync(join(repo, ref.path))) fail(file, `source "${ref.path}" does not exist in the repository`);
  }
  if (data.version === 'planned' && !(data.sources ?? []).some((ref) => ref.path.startsWith('.ai/specs/')))
    fail(file, 'a planned page must list its specification in sources');

  for (const [, target] of body.matchAll(/(?:\]\(|href=")(\/docs[^)"#\s]*)/g)) {
    const slug = target.replace(/^\/docs\/?/, '').replace(/\/$/, '');
    if (!slugs.has(slug)) fail(file, `link to ${target} names no page`);
  }
  for (const [, src] of body.matchAll(/!\[[^\]]*\]\((\/[^)\s]+)\)/g)) {
    if (!existsSync(join(site, 'public', src))) fail(file, `image ${src} is missing from public/`);
  }
  for (const [, alt] of body.matchAll(/!\[([^\]]*)\]\(/g)) {
    if (!alt.trim()) fail(file, 'every image needs alt text');
  }
  for (const [variable] of text.matchAll(/\bCEZ_[A-Z0-9_]+\b/g)) {
    if (!envExample.includes(variable)) fail(file, `${variable} is not documented in .env.example`);
  }

  const words = prose(body);
  for (const [tag] of words.matchAll(/<\/?([A-Za-z][\w.]*)/g)) {
    const name = tag.replace(/^<\/?/, '');
    if (!ALLOWED_TAGS.has(name)) fail(file, `<${name}> is not an allowed component or HTML tag`);
  }
  if (EMOJI.test(words.replace(/[→←↗✓]/g, ''))) fail(file, 'contains an emoji');
  for (const [word] of words.matchAll(STYLE_WORDS)) fail(file, `avoid "${word}" (see Voice in the contribution guide)`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`\n${errors.length} problem(s) in ${pages.length} pages.`);
  process.exit(1);
}
console.log(`Checked ${pages.length} pages: frontmatter, links, images, env vars, and style.`);
