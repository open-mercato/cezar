#!/usr/bin/env node
// Lists the backports still owed (docs/publishing.md § Release lines): every PR merged in the last
// `--days` (default 30) whose `backport <branch>` label has no open or merged backport PR yet.
// The Backport workflow runs this in the repository's own context — on pushes to main, on a
// schedule and on same-repo PR events — so a fork PR is backported like any other.
//
// Writes `jobs` (a JSON matrix) and `count` to $GITHUB_OUTPUT. Env: GH_TOKEN, GITHUB_REPOSITORY.

import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { backportBranch, BACKPORT_LABEL, planBackports, type BackportState } from '../packages/cezar/src/release/backport.ts';
import { githubClient } from './lib/github.mts';

const { values: flags } = parseArgs({ options: { days: { type: 'string', default: '30' } } });
const days = Number(flags.days);
if (!Number.isFinite(days) || days <= 0) throw new Error(`--days must be a positive number, not ${flags.days}`);

const gh = githubClient({ token: process.env.GH_TOKEN, repository: process.env.GITHUB_REPOSITORY });
const pulls = await gh.mergedPulls(days);

const targets = new Set<string>();
const existing = new Map<string, BackportState>();
for (const pull of pulls) {
  for (const label of pull.labels) {
    const target = BACKPORT_LABEL.exec(label)?.[1];
    if (!target) continue;
    targets.add(target);
    const branch = backportBranch(pull.number, target);
    const state = await gh.pullStateByHead(branch);
    if (state === 'closed' && (await gh.getBranchSha(branch)) !== null) {
      console.log(`backport-queue: #${pull.number} → ${target} waits: its closed backport left ${branch}; delete that branch to re-run`);
      existing.set(branch, 'closed-branch-kept');
    } else if (state) existing.set(branch, state);
  }
}
const branches = new Set<string>();
for (const target of targets) if ((await gh.getBranchSha(target)) !== null) branches.add(target);

const jobs = planBackports({ pulls, existing, branches });
for (const job of jobs) console.log(`backport-queue: #${job.pr} → ${job.target}`);
console.log(`backport-queue: ${jobs.length} backport(s) owed across ${pulls.length} PR(s) merged in the last ${days} days`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `jobs=${JSON.stringify({ include: jobs })}\ncount=${jobs.length}\n`);
}
