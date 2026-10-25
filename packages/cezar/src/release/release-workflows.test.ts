import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Contracts of the release-line workflows (docs/publishing.md § Release lines) that a YAML edit
// can break without any script test noticing.

const root = new URL('../../../../', import.meta.url);
const load = (rel: string) => parse(readFileSync(new URL(rel, root), 'utf8')) as Record<string, any>;
const text = (rel: string) => readFileSync(new URL(rel, root), 'utf8');
const RELEASE_WORKFLOWS = ['release.yml', 'release-cut.yml', 'release-publish.yml', 'backport.yml'];
const steps = (wf: Record<string, any>) => Object.values(wf.jobs as Record<string, any>).flatMap((j) => j.steps as any[]);

describe('release workflows', () => {
  it.each(RELEASE_WORKFLOWS)('%s writes only with the release App token, never a fallback', (file) => {
    const src = text(`.github/workflows/${file}`);
    expect(src).not.toMatch(/secrets\.RELEASE_TOKEN/);
    // A PR or tag made with GITHUB_TOKEN starts no workflow: a silent fallback ships PRs without CI.
    expect(src).not.toMatch(/github\.token|secrets\.GITHUB_TOKEN/);
  });

  it('publishes from the tag push, at the tagged commit, one run at a time', () => {
    const wf = load('.github/workflows/release-publish.yml');
    expect(wf.on.push.tags).toEqual(['v*']);
    expect(wf.concurrency.group).toBe('release-publish');
    const checkout = steps(wf).find((s) => String(s.uses).startsWith('actions/checkout@'));
    // npm provenance attests the run's own commit; checking anything else out would lie.
    expect(checkout.with?.ref).toBeUndefined();
    expect(wf.permissions['id-token']).toBe('write');
    expect(wf.jobs.publish.environment).toBe('production');
  });

  it('keeps publishing out of the Release workflow', () => {
    const wf = load('.github/workflows/release.yml');
    expect(wf.permissions['id-token']).toBeUndefined();
    expect(text('.github/workflows/release.yml')).not.toMatch(/scripts\/release\.mjs/);
    // "Re-run jobs" replays the dispatch SHA; the line's tip is what an earlier attempt bumped.
    const checkout = steps(wf).find((s) => String(s.uses).startsWith('actions/checkout@'));
    expect(checkout.with.ref).toBe('${{ github.ref_name }}');
  });

  it('runs the backport job only for PRs that carry a backport label', () => {
    const wf = load('.github/workflows/backport.yml');
    const condition = String(wf.jobs.backport.if);
    expect(condition).toMatch(/contains\(join\(github\.event\.pull_request\.labels\.\*\.name/);
    const action = steps(wf).find((s) => String(s.uses).startsWith('korthout/backport-action@'));
    expect(String(action.with.copy_labels_pattern)).not.toMatch(/qa-approved/);
  });
});

describe('.github/release.yml', () => {
  it('parses, and lists every exclusion and category label as a YAML list', () => {
    const config = load('.github/release.yml').changelog;
    expect(config.exclude.labels).toContain('skip-changelog');
    expect(Array.isArray(config.exclude.authors)).toBe(true);
    for (const category of config.categories) {
      expect(typeof category.title).toBe('string');
      expect(Array.isArray(category.labels)).toBe(true);
    }
    expect(config.categories.at(-1).labels).toEqual(['*']);
  });
});
