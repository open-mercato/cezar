import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import '../core/claude-cli-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const WF: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] };

describe('tmp deleted root', { timeout: 60_000 }, () => {
  for (const op of ['finish', 'cancel'] as const) {
    it(op, async () => {
      process.env.CEZ_DRY_RUN = '1';
      const root = mkdtempSync(join(tmpdir(), 'cez-del-'));
      await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
      writeFileSync(join(root, 'a.md'), 'a\n');
      await run('git', ['add', '-A'], { cwd: root });
      await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
      const store = RunStore.open(join(root, '.ai/cezar'));
      const manager = new RunManager(store, root);
      const rec = manager.startRun(WF, { task: 'do it mock:done' });
      const dl = Date.now() + 30_000;
      while (store.getRun(rec.id)?.status !== 'waiting') {
        if (Date.now() > dl) throw new Error('no waiting: ' + store.getRun(rec.id)?.status);
        await new Promise((r) => setTimeout(r, 50));
      }
      console.log('WAITING worktreePath', store.getRun(rec.id)?.worktreePath);
      rmSync(root, { recursive: true, force: true });
      // trace recreation
      const origMk = fs.mkdirSync;
      const traces: string[] = [];
      const watcher = setInterval(() => {
        if (existsSync(root) && traces.length === 0) traces.push('root reappeared at ' + Date.now());
      }, 5);
      try {
        const r = op === 'finish' ? manager.finish(rec.id) : manager.cancel(rec.id);
        console.log(op, 'RETURNED', r);
      } catch (e) {
        console.log(op, 'THREW', (e as Error).stack);
      }
      const dl2 = Date.now() + 10_000;
      while (!['done', 'cancelled', 'failed'].includes(store.getRun(rec.id)?.status ?? '') && Date.now() < dl2)
        await new Promise((r) => setTimeout(r, 50));
      console.log(op, 'final status', store.getRun(rec.id)?.status);
      try { store.flush(); } catch (e) { console.log('flush THREW', (e as Error).stack); }
      await new Promise((r) => setTimeout(r, 1500));
      clearInterval(watcher);
      console.log(op, 'root exists after:', existsSync(root), traces, existsSync(root) ? run('find', [root]).then((x) => console.log(x.stdout)) : '');
      await new Promise((r) => setTimeout(r, 200));
      void origMk;
      manager.dispose();
      rmSync(root, { recursive: true, force: true });
      expect(true).toBe(true);
    });
  }
});
