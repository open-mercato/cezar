import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { admitAgent, AgentAdmissionError, type AgentAdmissionContext } from './agent-admission.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function project(command?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'cezar-admission-'));
  roots.push(root);
  mkdirSync(join(root, '.ai', 'cezar'), { recursive: true });
  if (command) {
    writeFileSync(join(root, '.ai', 'cezar', 'config.json'), JSON.stringify({
      agentAdmission: {
        beforeAgent: {
          id: '3436ef6f-d65d-4112-b0ee-9548669fff6b',
          command,
          timeoutSeconds: 5,
        },
      },
    }));
  }
  return root;
}

function context(root: string): AgentAdmissionContext {
  return {
    schemaVersion: 1,
    phase: 'before-agent',
    projectId: 'pilot',
    projectRoot: root,
    workspace: { path: root, branch: 'cez/12345678', baseBranch: 'development' },
    run: { id: '12345678-1234-1234-1234-123456789abc', title: 'Pilot', task: 'Implement #42', issueNumber: 42 },
    launch: { kind: 'workflow', stepId: 'implement', runner: 'codex' },
  };
}

describe('agent admission', () => {
  it('is zero-config and allows an agent when no hook is present', async () => {
    const root = project();
    await expect(admitAgent(root, context(root))).resolves.toEqual({ configured: false, decision: { decision: 'allow' } });
  });

  it('runs in the native workspace with the complete context', async () => {
    const root = project(`node -e 'const c=JSON.parse(process.env.CEZ_AGENT_ADMISSION_CONTEXT); if(c.workspace.path!==process.cwd()||c.run.issueNumber!==42||c.launch.kind!=="workflow") process.exit(2); console.log(JSON.stringify({decision:"allow",handle:c.run.id}))'`);
    const result = await admitAgent(root, context(root));
    expect(result.configured).toBe(true);
    expect(result.decision).toEqual({ decision: 'allow', handle: '12345678-1234-1234-1234-123456789abc' });
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns a structured denial', async () => {
    const root = project(`printf '%s\\n' '{"decision":"deny","reason":"issue is not READY"}'`);
    await expect(admitAgent(root, context(root))).resolves.toMatchObject({
      configured: true,
      decision: { decision: 'deny', reason: 'issue is not READY' },
    });
  });

  it('fails closed for a tracked admission command', async () => {
    const root = project(`printf '%s\\n' '{"decision":"allow"}'`);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.ai/cezar/config.json'], { cwd: root });
    await expect(admitAgent(root, context(root))).rejects.toThrow(AgentAdmissionError);
  });

  it('fails closed for ambiguous command output', async () => {
    const root = project(`printf '%s\\n%s\\n' '{"decision":"allow"}' '{"decision":"allow"}'`);
    await expect(admitAgent(root, context(root))).rejects.toThrow('exactly one JSON decision line');
  });
});
