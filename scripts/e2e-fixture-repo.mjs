#!/usr/bin/env node
// Builds the small, deterministic git repository the e2e suite boots cezar against
// (`e2e.config.ts`). One per run, keyed by port, so parallel runs never share a
// `.ai/cezar/` store or a worktree. Idempotent: an existing repo is left as is.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The workspace config for this run's CEZ_HOME: a wider parallel cap than the shipped default
// of 2, so the files that start tasks concurrently are not queued behind each other.
const home = process.env.CEZ_HOME;
if (home) {
  mkdirSync(home, { recursive: true });
  const config = join(home, 'config.json');
  if (!existsSync(config)) writeFileSync(config, JSON.stringify({ resources: { maxParallel: 8 } }, null, 2) + '\n');
}

const dir = resolve(process.argv[2] ?? '.e2e/fixtures/repo');
if (existsSync(join(dir, '.git'))) process.exit(0);
mkdirSync(join(dir, 'src'), { recursive: true });
mkdirSync(join(dir, 'docs'), { recursive: true });

const git = (...args) =>
  execFileSync('git', args, {
    cwd: dir,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'E2E Fixture',
      GIT_AUTHOR_EMAIL: 'e2e@example.test',
      GIT_COMMITTER_NAME: 'E2E Fixture',
      GIT_COMMITTER_EMAIL: 'e2e@example.test',
      GIT_AUTHOR_DATE: '2026-01-01T09:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T09:00:00Z',
    },
  });
const write = (rel, text) => writeFileSync(join(dir, rel), text);

git('init', '-q', '-b', 'main');
git('config', 'commit.gpgsign', 'false');

write('README.md', '# Fixture app\n\nA tiny project the cezar e2e suite runs agents against.\n');
write('.gitignore', 'node_modules/\ndist/\n.ai/\n');
write('package.json', JSON.stringify({ name: 'fixture-app', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
write('src/index.ts', "import { greet } from './greet.ts';\n\nconsole.log(greet('world'));\n");
write('src/greet.ts', "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n");
git('add', '-A');
git('commit', '-q', '-m', 'Initial fixture app');

write('docs/guide.md', '# Guide\n\nHow the fixture app is used in tests.\n');
write('src/greet.ts', "export function greet(name: string): string {\n  return `Hello, ${name.trim()}!`;\n}\n");
git('add', '-A');
git('commit', '-q', '-m', 'Trim the greeting name and add a guide');

git('checkout', '-q', '-b', 'feature/farewell');
write('src/farewell.ts', "export function farewell(name: string): string {\n  return `Goodbye, ${name}!`;\n}\n");
git('add', '-A');
git('commit', '-q', '-m', 'Add a farewell helper');
git('checkout', '-q', 'main');

write('src/index.ts', "import { greet } from './greet.ts';\n\nexport function main(): void {\n  console.log(greet('world'));\n}\n\nmain();\n");
git('add', '-A');
git('commit', '-q', '-m', 'Wrap the entry point in main()');

