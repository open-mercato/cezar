import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { citedPaths, collectEvidence, publicSurfaceCandidates, runCommand, type CommandRunner, type EvidenceResult } from './evidence.ts';
import { fixtureRepo, type FixtureRepo } from './fixture-repo.testkit.ts';

let repo: FixtureRepo | undefined;
afterEach(() => {
  repo?.dispose();
  repo = undefined;
});

function ok(result: EvidenceResult) {
  if (!result.ok) throw new Error(result.error);
  return result.evidence;
}

/** Real git, scripted gh (test_github_mode_checks_repository_and_uses_exact_oids). */
function fakeGh(responses: Record<string, unknown>): CommandRunner {
  return async (cmd, args, cwd) => {
    if (cmd === 'git') return runCommand(cmd, args, cwd);
    const key = args.slice(0, 2).join(' ');
    if (!(key in responses)) return { ok: false, stdout: Buffer.from(''), code: 1 };
    return { ok: true, stdout: Buffer.from(JSON.stringify(responses[key])), code: 0 };
  };
}

describe('collectEvidence', () => {
  it('renames, spaces and tabs, and a dirty worktree left untouched (test_collect_renames_spaces_tabs_and_preserve_dirty_worktree)', async () => {
    repo = fixtureRepo();
    repo.write('module with space.py', 'answer = 1\n');
    const base = repo.commit('base');
    renameSync(join(repo.root, 'module with space.py'), join(repo.root, 'renamed\tmodule.py'));
    repo.commit('rename');
    writeFileSync(join(repo.root, 'untracked.txt'), 'preserve me');
    const before = repo.git('status', '--porcelain', '-z');
    const evidence = ok(await collectEvidence(repo.root, { mode: 'range', base, head: 'HEAD' }));
    expect(evidence.comparison.merge_base).toBe(base);
    expect(new Set(evidence.changed_files.map((f) => f.status))).toEqual(new Set(['D', 'A']));
    expect(evidence.changed_files.map((f) => f.path)).toContain('renamed\tmodule.py');
    expect(evidence.worktree_dirty).toBe(true);
    expect(repo.git('status', '--porcelain', '-z')).toBe(before);
  });

  it('github mode checks the repository and uses the exact oids', async () => {
    repo = fixtureRepo();
    repo.write('x.py', 'x = 1\n');
    const base = repo.commit('base');
    repo.write('x.py', 'x = 2\n');
    const head = repo.commit('head');
    const run = fakeGh({
      'repo view': { nameWithOwner: 'example/project' },
      'pr view': { baseRefOid: base, headRefOid: head, title: 'Example', number: 1 },
    });
    const evidence = ok(await collectEvidence(repo.root, { mode: 'pr', pr: 'https://github.com/example/project/pull/1' }, run));
    expect(evidence.comparison.head).toBe(head);
    expect(evidence.comparison.base).toBe(base);
    expect(evidence.pr.title).toBe('Example');
    const other = await collectEvidence(repo.root, { mode: 'pr', pr: 'https://github.com/another/project/pull/1' }, run);
    expect(other).toEqual({ ok: false, error: 'PR repository does not match checkout' });
  });

  it('a PR number skips the identity check; bad gh output and missing commits are reported', async () => {
    repo = fixtureRepo();
    repo.write('a.txt', '1\n');
    const base = repo.commit('base');
    repo.write('a.txt', '2\n');
    const head = repo.commit('head');
    const good = await collectEvidence(repo.root, { mode: 'pr', pr: '7' }, fakeGh({ 'pr view': { baseRefOid: base, headRefOid: head } }));
    expect(ok(good).changed_files).toEqual([{ status: 'M', path: 'a.txt' }]);
    const shape = await collectEvidence(repo.root, { mode: 'pr', pr: '7' }, fakeGh({ 'pr view': { headRefOid: 'nope' } }));
    expect(shape).toEqual({ ok: false, error: 'gh pr view returned an unexpected shape' });
    const missing = await collectEvidence(repo.root, { mode: 'pr', pr: '7' }, fakeGh({ 'pr view': { baseRefOid: base, headRefOid: 'f'.repeat(40) } }));
    expect(missing.ok === false && missing.error).toMatch(/not available locally; it is never fetched/);
    const noGh = await collectEvidence(repo.root, { mode: 'pr', pr: '7' }, fakeGh({}));
    expect(noGh.ok === false && noGh.error).toMatch(/^gh pr failed/);
    const bad = await collectEvidence(repo.root, { mode: 'pr', pr: 'https://evil.example/pull/1' }, fakeGh({}));
    expect(bad.ok).toBe(false);
  });

  it('refuses option-looking refs and degrades outside a repository', async () => {
    repo = fixtureRepo();
    repo.write('a.txt', '1\n');
    repo.commit('base');
    expect(await collectEvidence(repo.root, { mode: 'range', base: '--output=/tmp/x', head: 'HEAD' })).toEqual({ ok: false, error: 'Invalid commit reference' });
    const outside = await collectEvidence('/', { mode: 'range', base: 'main', head: 'HEAD' });
    expect(outside.ok).toBe(false);
  });

  it('a removed Store API route and other PHP surfaces become public surface candidates', async () => {
    repo = fixtureRepo();
    repo.write('src/Core/Checkout/SalesChannel/CartLineItemRoute.php', '<?php #[Route(path: "/store-api/checkout/cart/line-item")] class CartLineItemRoute {}\n');
    repo.write('src/Core/Checkout/Event/CheckoutOrderPlacedEvent.php', '<?php class CheckoutOrderPlacedEvent {}\n');
    repo.write('src/Resources/config/services.xml', '<container/>\n');
    repo.write('src/Core/Content/ProductReviewDefinition.php', '<?php class ProductReviewDefinition {}\n');
    repo.write('src/Internal/Helper.php', '<?php class Helper {}\n');
    const base = repo.commit('base');
    repo.git('rm', '-q', 'src/Core/Checkout/SalesChannel/CartLineItemRoute.php');
    repo.write('src/Core/Checkout/Event/CheckoutOrderPlacedEvent.php', '<?php class CheckoutOrderPlacedEvent { public function getSalesChannelContext() {} }\n');
    repo.write('src/Migration/Migration1700000000AddVerified.php', '<?php class Migration1700000000AddVerified {}\n');
    repo.write('src/Resources/app/administration/src/module/sw-product/page/sw-product-detail.html.twig', '{% block sw_product_detail_base %}{% endblock %}\n');
    repo.write('src/Internal/Helper.php', '<?php class Helper { }\n');
    repo.commit('head');
    const evidence = ok(await collectEvidence(repo.root, { mode: 'range', base, head: 'HEAD' }));
    const byPath = new Map(evidence.public_surface_candidates.map((c) => [c.path, c]));
    expect(byPath.get('src/Core/Checkout/SalesChannel/CartLineItemRoute.php')).toMatchObject({ status: 'D', ecosystem: 'shopware', surface: 'http' });
    expect(byPath.get('src/Core/Checkout/Event/CheckoutOrderPlacedEvent.php')).toMatchObject({ status: 'M', surface: 'event' });
    expect(byPath.get('src/Migration/Migration1700000000AddVerified.php')).toMatchObject({ status: 'A', surface: 'schema' });
    expect(byPath.get('src/Resources/app/administration/src/module/sw-product/page/sw-product-detail.html.twig')).toMatchObject({ surface: 'extension-point' });
    expect(byPath.has('src/Internal/Helper.php')).toBe(false);
  });

  it('spec mode pins the blob, reads the text and keeps the cited paths that exist', async () => {
    repo = fixtureRepo();
    repo.write('packages/contract/src/runs.ts', 'export {}\n');
    repo.write('src/server.ts', 'export {}\n');
    repo.write('AGENTS.md', '# rules\n');
    repo.write('.ai/specs/2026-01-01-thing.md', '# Thing\n\nTouches `packages/contract/src/runs.ts:12-30` and [server](src/server.ts), not `src/ghost.ts`.\nSee `packages/contract/`.\n');
    const head = repo.commit('spec');
    const evidence = ok(await collectEvidence(join(repo.root, '.ai'), { mode: 'spec', path: 'specs/2026-01-01-thing.md' }));
    expect(evidence.mode).toBe('spec');
    expect(evidence.comparison).toEqual({ base: head, head, merge_base: head, semantics: 'spec-at-head' });
    expect(evidence.spec?.path).toBe('.ai/specs/2026-01-01-thing.md');
    expect(evidence.spec?.blob_sha).toBe(repo.git('rev-parse', 'HEAD:.ai/specs/2026-01-01-thing.md').trim());
    expect(evidence.spec?.text).toContain('# Thing');
    expect(evidence.spec?.cited_paths.sort()).toEqual(['packages/contract', 'packages/contract/src/runs.ts', 'src/server.ts']);
    expect(evidence.public_surface_candidates.map((c) => c.path).sort()).toEqual(['packages/contract/src/runs.ts']);
    expect(evidence.changed_files).toEqual([]);
    expect(evidence.context_candidates).toContain('AGENTS.md');
  });

  it('spec mode refuses an uncommitted spec and a path outside the repository', async () => {
    repo = fixtureRepo();
    repo.write('README.md', 'x\n');
    repo.commit('base');
    repo.write('draft.md', '# draft\n');
    const draft = await collectEvidence(repo.root, { mode: 'spec', path: 'draft.md' });
    expect(draft.ok === false && draft.error).toMatch(/not committed at HEAD/);
    const outside = await collectEvidence(repo.root, { mode: 'spec', path: '../etc/passwd' });
    expect(outside.ok === false && outside.error).toMatch(/inside the repository/);
  });
});

describe('helpers', () => {
  it('maps per-ecosystem public surfaces', () => {
    const paths = ['packages/api/index.ts', 'types/foo.d.ts', 'openapi.yaml', 'packages/contract/src/a.ts', '.env.example', 'db/migrations/001.sql', 'src/lib/util.ts'];
    expect(publicSurfaceCandidates(paths.map((path) => ({ path }))).map((c) => [c.path, c.surface])).toEqual([
      ['packages/api/index.ts', 'export'],
      ['types/foo.d.ts', 'export'],
      ['openapi.yaml', 'http'],
      ['packages/contract/src/a.ts', 'http'],
      ['.env.example', 'config'],
      ['db/migrations/001.sql', 'schema'],
    ]);
  });

  it('cited paths ignore what is not tracked', () => {
    expect(citedPaths('`a/b.ts` `./c.md` `nope.ts`', new Set(['a/b.ts', 'c.md']))).toEqual(['a/b.ts', 'c.md']);
  });
});
