import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapRepoSandbox } from './sandbox-bootstrap.ts';
import { noteInstalls } from './containerfile-store.ts';
import type { SandboxConfig } from '../config.ts';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

function repo(): { root: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'cez-bootstrap-'));
  made.push(root);
  const dataDir = join(root, '.ai/cezar');
  mkdirSync(dataDir, { recursive: true });
  return { root, dataDir };
}

const sandbox = (over: Partial<SandboxConfig> = {}): SandboxConfig => ({
  enabled: true,
  provider: 'podman',
  name: 'demo',
  tmpdir: '/tmp/cez-agent',
  containerfile: '.ai/cezar/Containerfile',
  claudeCredentialPassthrough: true,
  resources: { shmSize: '1g' },
  ...over,
} as SandboxConfig);

describe('what a first isolated run leaves behind', () => {
  it('writes a MINIMAL block, so the repo keeps following the machine template', () => {
    // Writing the merged configuration would pin today's copy of the machine
    // template: change an ssh key machine-wide afterwards and this project would
    // quietly not follow. Only what identifies the project is written.
    const { root, dataDir } = repo();
    const result = bootstrapRepoSandbox(root, dataDir, sandbox({
      credentials: { enabled: { ssh: true } },
      resources: { shmSize: '2g', memory: '8g' },
    } as Partial<SandboxConfig>));

    expect(result.config).toBeDefined();
    const written = JSON.parse(readFileSync(join(root, '.ai/cezar/config.json'), 'utf8'));
    expect(written).toEqual({ sandbox: { enabled: true, name: 'demo' } });
    expect(JSON.stringify(written)).not.toContain('ssh');
    expect(JSON.stringify(written)).not.toContain('8g');
  });

  it('writes the packages the task installed, so the next one starts with them', () => {
    const { root, dataDir } = repo();
    noteInstalls(dataDir, 'apt-get install -y ripgrep');
    noteInstalls(dataDir, 'npm install -g pnpm');

    const result = bootstrapRepoSandbox(root, dataDir, sandbox());
    expect(result.installs).toBe(2);
    const containerfile = readFileSync(join(root, '.ai/cezar/Containerfile'), 'utf8');
    expect(containerfile).toContain('ripgrep');
    expect(containerfile).toContain('pnpm');
  });

  it('NEVER touches a repo that has a config of its own', () => {
    // The gate. A repo that has said anything owns its configuration, and the
    // propose-and-accept flow stays the way its owner maintains the file.
    const { root, dataDir } = repo();
    const mine = JSON.stringify({ sandbox: { enabled: false, name: 'mine' } });
    writeFileSync(join(root, '.ai/cezar/config.json'), mine, 'utf8');
    noteInstalls(dataDir, 'apt-get install -y ripgrep');

    const result = bootstrapRepoSandbox(root, dataDir, sandbox());
    expect(result).toEqual({ installs: 0 });
    expect(readFileSync(join(root, '.ai/cezar/config.json'), 'utf8')).toBe(mine);
    expect(existsSync(join(root, '.ai/cezar/Containerfile'))).toBe(false);
  });

  it('leaves an existing Containerfile alone — that file has an owner', () => {
    const { root, dataDir } = repo();
    writeFileSync(join(root, '.ai/cezar/Containerfile'), 'FROM scratch\n', 'utf8');
    noteInstalls(dataDir, 'apt-get install -y ripgrep');

    const result = bootstrapRepoSandbox(root, dataDir, sandbox());
    expect(result.config).toBeDefined();
    expect(result.installs).toBe(0);
    expect(readFileSync(join(root, '.ai/cezar/Containerfile'), 'utf8')).toBe('FROM scratch\n');
  });

  it('with nothing installed, writes the config and no Containerfile', () => {
    const { root, dataDir } = repo();
    const result = bootstrapRepoSandbox(root, dataDir, sandbox());
    expect(result.config).toBeDefined();
    expect(result.containerfile).toBeUndefined();
    expect(existsSync(join(root, '.ai/cezar/Containerfile'))).toBe(false);
  });
});
