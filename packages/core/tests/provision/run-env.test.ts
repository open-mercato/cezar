import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '../../src/config/config.model.js';
import { detectComposeFile, firstComposeService } from '../../src/provision/compose-detect.js';
import { NativeShellEnv } from '../../src/provision/native-shell-env.js';
import { createRunEnv } from '../../src/provision/create-run-env.js';
import { tailLines } from '../../src/provision/run-env.js';

function projectEnv(overrides: Record<string, unknown> = {}) {
  return ConfigSchema.parse({ autofix: { projectEnv: overrides } }).autofix.projectEnv;
}

describe('compose-detect', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cezar-detect-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when no compose file is present', () => {
    expect(detectComposeFile(dir)).toBeNull();
  });

  it('detects docker-compose.yml with the right precedence', async () => {
    await writeFile(join(dir, 'compose.yaml'), 'services:\n  web: {}\n');
    await writeFile(join(dir, 'docker-compose.yml'), 'services:\n  web: {}\n');
    expect(detectComposeFile(dir)).toBe('docker-compose.yml');
  });

  it('extracts the first service name', async () => {
    await writeFile(
      join(dir, 'docker-compose.yml'),
      [
        'version: "3"',
        'services:',
        '  app:',
        '    build: .',
        '  db:',
        '    image: postgres',
        'volumes:',
        '  pg: {}',
      ].join('\n'),
    );
    expect(firstComposeService(dir, 'docker-compose.yml')).toBe('app');
  });

  it('returns null for a file with no services block', async () => {
    await writeFile(join(dir, 'docker-compose.yml'), 'version: "3"\nvolumes:\n  pg: {}\n');
    expect(firstComposeService(dir, 'docker-compose.yml')).toBeNull();
  });
});

describe('NativeShellEnv', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cezar-native-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs configured commands and reports success', async () => {
    const env = new NativeShellEnv(dir, projectEnv({ install: 'true', test: 'echo hello' }));
    const install = await env.install();
    expect(install?.ok).toBe(true);
    const test = await env.test();
    expect(test?.ok).toBe(true);
    expect(test?.stdout).toContain('hello');
  });

  it('returns null for unconfigured commands', async () => {
    const env = new NativeShellEnv(dir, projectEnv({ install: 'true' }));
    expect(await env.build()).toBeNull();
    expect(await env.test()).toBeNull();
  });

  it('reports a non-zero exit as not ok', async () => {
    const env = new NativeShellEnv(dir, projectEnv({ test: 'exit 3' }));
    const r = await env.test();
    expect(r?.ok).toBe(false);
    expect(r?.exitCode).toBe(3);
  });

  it('injects envVars', async () => {
    const env = new NativeShellEnv(
      dir,
      projectEnv({ test: 'echo $CEZAR_FOO', envVars: { CEZAR_FOO: 'bar' } }),
    );
    const r = await env.test();
    expect(r?.stdout).toContain('bar');
  });
});

describe('NativeShellEnv dev server', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cezar-dev-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('boots a server, probes readiness, and stops it on dispose', async () => {
    const port = 49000 + Math.floor(Math.random() * 10000);
    const command = `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(${port})"`;
    const env = new NativeShellEnv(
      dir,
      projectEnv({
        devServer: { enabled: true, command, port, readyPath: '/', readyTimeoutSec: 10 },
      }),
    );

    const handle = await env.startDevServer();
    expect(handle).not.toBeNull();
    expect(handle?.url).toBe(`http://127.0.0.1:${port}`);
    expect(handle?.ready).toBe(true);

    // a second call returns the same handle (idempotent)
    const again = await env.startDevServer();
    expect(again?.url).toBe(handle?.url);

    await env.dispose();
    // after dispose the port should be free again — a fresh probe fails
    const { waitForHttp } = await import('../../src/provision/run-env.js');
    const status = await waitForHttp(`http://127.0.0.1:${port}/`, 1000, 200);
    expect(status).toBeNull();
  }, 20000);

  it('returns null when the dev server is disabled', async () => {
    const env = new NativeShellEnv(dir, projectEnv({ devServer: { enabled: false } }));
    expect(await env.startDevServer()).toBeNull();
  });
});

describe('createRunEnv', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cezar-factory-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns a native env when kind is native', async () => {
    const env = await createRunEnv({
      worktreePath: dir,
      spec: projectEnv({ kind: 'native' }),
      runId: 'r1',
    });
    expect(env.kind).toBe('native');
  });

  it('returns native under auto when no compose file exists', async () => {
    const env = await createRunEnv({
      worktreePath: dir,
      spec: projectEnv({ kind: 'auto' }),
      runId: 'r1',
    });
    expect(env.kind).toBe('native');
  });

  it('throws under explicit compose when no compose file exists', async () => {
    await expect(
      createRunEnv({ worktreePath: dir, spec: projectEnv({ kind: 'compose' }), runId: 'r1' }),
    ).rejects.toThrow(/no compose file/i);
  });
});

describe('tailLines', () => {
  it('keeps the last N lines', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const tail = tailLines(text, 5);
    expect(tail.split('\n')).toHaveLength(5);
    expect(tail).toContain('line 99');
    expect(tail).not.toContain('line 94');
  });
});
