import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSecretsCommand } from './secrets-cli.ts';
import { SecretStore } from './secrets.ts';

const GREEN = 'greenpt-key-value-123';
const TENSOR = 'tensorx-key-value-456';
const GH = 'ghp_forward_token_789';

describe('cezar secrets import-sandcastle (fork #3)', () => {
  let root: string;
  let source: string;
  let lines: string[];
  let errors: string[];
  let store: SecretStore;
  let backend: 'keychain' | 'file';

  const write = (file: string, text: string) => { writeFileSync(join(source, file), text); chmodSync(join(source, file), 0o600); };
  const providers = (extra: Record<string, unknown> = {}) => JSON.stringify({
    version: 1,
    providers: {
      greenpt: { upstream: 'https://API.greenpt.invalid/v1', port: 18434, apiKeyEnv: 'GREENPT_API_KEY' },
      tensorx: { upstream: 'https://api.tensorx.invalid/v1', port: 18435, apiKeyEnv: 'TENSORX_API_KEY' },
      ollama: { upstream: 'http://localhost:11434/v1', port: 18436, apiKeyEnv: 'OLLAMA_API_KEY', local: true },
      ...extra,
    },
  });
  const snapshot = () => readdirSync(source).sort().map((f) => `${f}:${statSync(join(source, f)).mtimeMs}:${readFileSync(join(source, f), 'utf8')}`);
  const storeFiles = () => { try { return readdirSync(join(root, 'home', 'secrets')); } catch { return []; } };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-import-'));
    source = join(root, 'sandcastle');
    mkdirSync(source, { mode: 0o700 });
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    write('providers.json', providers());
    write('provider-keys.env', `GREENPT_API_KEY=${GREEN}\nTENSORX_API_KEY="${TENSOR}"\n# comment\n`);
    write('forwards.env', `GH_TOKEN=${GH}\n`);
    lines = [];
    errors = [];
    backend = 'keychain';
    store = new SecretStore(process.env, { keychain: async () => null });
    vi.spyOn(store, 'keyBackend').mockImplementation(async () => backend);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

  const run = (args: string[]) => runSecretsCommand(['import-sandcastle', '--dir', source, '--workspace', ...args], {
    log: (l) => lines.push(l), error: (l) => errors.push(l),
  }, process.env, store);
  const everything = () => [...lines, ...errors].join('\n');
  const stored = async () => (await store.read({ kind: 'workspace' })).values;

  it('dry run lists what would happen, writes nothing and never prints a value', async () => {
    const before = snapshot();
    expect(await run([])).toBe(0);
    expect(lines).toEqual([
      'would import\tGREENPT_API_KEY\tapi.greenpt.invalid Authorization bearer',
      'would import\tTENSORX_API_KEY\tapi.tensorx.invalid Authorization bearer',
      'skip\tOLLAMA_API_KEY\tprovider ollama: local provider, no credential leaves the machine',
      'skip\tGH_TOKEN\tforwards.env: needs a binding: add --bind GH_TOKEN=host1,host2:header:scheme',
    ]);
    expect(errors.join('\n')).toContain('dry run');
    expect(everything()).not.toMatch(new RegExp(`${GREEN}|${TENSOR}|${GH}`));
    expect(storeFiles()).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('--apply stores proxy secrets with bindings that resolve to the original values, source untouched', async () => {
    const before = snapshot();
    expect(await run(['--apply', '--bind', 'GH_TOKEN=github.com,api.github.com:Authorization:basic'])).toBe(0);
    const values = await stored();
    expect(Object.keys(values).sort()).toEqual(['GH_TOKEN', 'GREENPT_API_KEY', 'TENSORX_API_KEY']);
    expect(values.GREENPT_API_KEY).toMatchObject({ value: GREEN, audiences: ['proxy'], binding: { hosts: ['api.greenpt.invalid'], header: 'Authorization', scheme: 'bearer', sentinel: 'GREENPT_API_KEY' } });
    expect(values.TENSORX_API_KEY?.value).toBe(TENSOR);
    expect(values.GH_TOKEN).toMatchObject({ value: GH, binding: { hosts: ['api.github.com', 'github.com'], scheme: 'basic', sentinel: 'GH_TOKEN' } });
    const { secrets } = await store.resolveProxy(undefined, ['GREENPT_API_KEY', 'GH_TOKEN']);
    expect(secrets.map((s) => [s.name, s.value])).toEqual([['GREENPT_API_KEY', GREEN], ['GH_TOKEN', GH]]);
    expect(everything()).not.toMatch(new RegExp(`${GREEN}|${TENSOR}|${GH}`));
    expect(snapshot()).toEqual(before);
  });

  it('is idempotent: a second run skips stored names, --replace overwrites', async () => {
    expect(await run(['--apply'])).toBe(0);
    lines.length = 0;
    expect(await run(['--apply'])).toBe(0);
    expect(lines.filter((l) => l.startsWith('skip\tGREENPT_API_KEY'))).toEqual(['skip\tGREENPT_API_KEY\talready stored; --replace overwrites it']);
    write('provider-keys.env', `GREENPT_API_KEY=rotated-value-123456\nTENSORX_API_KEY=${TENSOR}\n`);
    expect(await run(['--apply', '--replace'])).toBe(0);
    expect((await stored()).GREENPT_API_KEY?.value).toBe('rotated-value-123456');
  });

  it('refuses a file data key on --apply and writes nothing, unless allowed', async () => {
    backend = 'file';
    expect(await run(['--apply'])).toBe(1);
    expect(errors.join('\n')).toContain('--allow-file-key');
    expect(storeFiles()).toEqual([]);
    expect(await run([])).toBe(0);
    expect(await run(['--apply', '--allow-file-key'])).toBe(0);
    expect(Object.keys(await stored())).toHaveLength(2);
  });

  it('a refused name, a missing value or a bad upstream fails the whole run with nothing written', async () => {
    write('providers.json', providers({
      bad: { upstream: 'https://x.invalid/v1', port: 1, apiKeyEnv: 'PATH' },
      nokey: { upstream: 'https://y.invalid/v1', port: 2, apiKeyEnv: 'NOKEY_API_KEY' },
      weird: { upstream: 'not a url', port: 3, apiKeyEnv: 'WEIRD_API_KEY' },
    }));
    write('provider-keys.env', `GREENPT_API_KEY=${GREEN}\nPATH=path-value-12345\nWEIRD_API_KEY=weird-value-123\n`);
    expect(await run(['--apply'])).toBe(1);
    expect(lines.filter((l) => l.startsWith('error\t')).map((l) => l.split('\t')[1]).sort()).toEqual(['NOKEY_API_KEY', 'PATH', 'TENSORX_API_KEY', 'WEIRD_API_KEY']);
    expect(everything()).not.toMatch(/path-value-12345|weird-value-123/);
    expect(storeFiles()).toEqual([]);
  });

  it('a --bind that matches no forward, or a malformed one, is refused', async () => {
    expect(await run(['--bind', 'NOPE=a.com:Authorization:bearer'])).toBe(1);
    expect(lines.join('\n')).toContain('matches no forwards.env entry');
    expect(await run(['--bind', 'GH_TOKEN=*.github.com:Authorization:basic'])).toBe(1);
    expect(errors.join('\n')).toContain('exact lowercase hostname');
    expect(await run(['--bind', 'GH_TOKEN=github.com'])).toBe(1);
    expect(errors.join('\n')).toContain('--bind GH_TOKEN');
  });

  it.each([
    ['missing providers.json', () => rmSync(join(source, 'providers.json')), /no providers\.json/],
    ['unparseable providers.json', () => write('providers.json', '{nope'), /cannot read providers\.json/],
    ['malformed env line', () => write('provider-keys.env', 'this has no equals sign secret-looking-text\n'), /provider-keys\.env line 1 is not NAME=value/],
    ['unreadable forwards.env', () => { rmSync(join(source, 'forwards.env')); mkdirSync(join(source, 'forwards.env')); }, /cannot read forwards\.env/],
  ])('%s: a clear message, non-zero, nothing written', async (_label, break_, message) => {
    break_();
    expect(await run(['--apply'])).toBe(1);
    expect(errors.join('\n')).toMatch(message);
    expect(everything()).not.toContain('secret-looking-text');
    expect(storeFiles()).toEqual([]);
  });

  it('defaults the source to RPI_PROXY_STORE_DIR', async () => {
    vi.stubEnv('RPI_PROXY_STORE_DIR', source);
    expect(await runSecretsCommand(['import-sandcastle', '--workspace'], { log: (l) => lines.push(l), error: (l) => errors.push(l) }, process.env, store)).toBe(0);
    expect(lines[0]).toContain('would import\tGREENPT_API_KEY');
  });

  it('imports into a registered project with --repo, and says when there is none', async () => {
    expect(await runSecretsCommand(['import-sandcastle', '--dir', source, '--repo', join(root, 'nowhere')], { log: (l) => lines.push(l), error: (l) => errors.push(l) }, process.env, store)).toBe(1);
    expect(errors.join('\n')).toContain('not a registered cezar project');
  });

  it('prints usage for an unknown flag', async () => {
    expect(await run(['--wat'])).toBe(1);
    expect(errors.join('\n')).toContain('import-sandcastle');
  });
});
