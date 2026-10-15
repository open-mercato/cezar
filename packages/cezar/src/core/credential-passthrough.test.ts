import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_CATALOG,
  credentialCopyPlan,
  credentialEnvPairs,
  credentialMountArgs,
  listSshEntries,
  resolvePassthrough,
  sanitizeSshConfig,
  type SshFs,
} from './credential-passthrough.ts';

const HOME = '/Users/k';
const allExist = () => true;
const noneExist = () => false;

describe('credential passthrough', () => {
  it('passes nothing unless asked — isolation is the default', () => {
    expect(resolvePassthrough(undefined, HOME, allExist)).toEqual([]);
    expect(resolvePassthrough({}, HOME, allExist)).toEqual([]);
  });

  it('each catalog entry is the credential alone, never a whole home directory', () => {
    // The same rule as mounting `.credentials.json` instead of all of ~/.claude:
    // a tool's key is not its history, its cache, or its other projects.
    for (const source of CREDENTIAL_CATALOG) {
      expect(source.hostPath === '.' || source.hostPath === '').toBe(false);
      expect(source.hostPath?.startsWith('..')).not.toBe(true);
    }
  });

  it('mount vs copy is per credential, with a default that fits the tool', () => {
    // gcloud refreshes its OAuth token in place, so a copy goes stale.
    expect(CREDENTIAL_CATALOG.find((c) => c.id === 'gcloud')?.defaultMode).toBe('mount');
    // A gh token is static — a copy keeps the container from rewriting yours.
    expect(CREDENTIAL_CATALOG.find((c) => c.id === 'github-cli')?.defaultMode).toBe('copy');
  });

  it('never FILE-mounts something its owner rewrites — mount the directory instead', () => {
    // A bind mount binds an inode; an atomic rewrite unlinks it and the
    // container is left holding a deleted file. This cost us the Claude
    // credential in practice, so the catalog may not repeat it.
    // `kind` is declared, not sniffed: `.ssh` (a directory) and `.npmrc` (a
    // file) are indistinguishable as path strings.
    for (const source of CREDENTIAL_CATALOG) {
      if (source.defaultMode !== 'mount') continue;
      expect(
        source.kind,
        `${source.id} mounts ${source.hostPath} — mount its directory or copy it`,
      ).toBe('dir');
    }
  });

  it('the operator can override the mode per credential', () => {
    const resolved = resolvePassthrough(
      { enabled: { gcloud: { mode: 'copy' } } }, HOME, allExist,
    );
    expect(resolved[0]?.mode).toBe('copy');
  });

  it('a missing file is SKIPPED with a reason, never mounted', () => {
    // podman would create an empty directory there, and an empty ~/.aws reads
    // to every tool as "logged out" — a worse failure than "not found".
    const resolved = resolvePassthrough({ enabled: { aws: true } }, HOME, noneExist);
    expect(resolved[0]?.skipped).toMatch(/does not exist/);
    expect(credentialMountArgs(resolved)).toEqual([]);
    expect(credentialCopyPlan(resolved, 'cez-1')).toEqual([]);
  });

  it('mounts and copies land in the right mechanism', () => {
    const resolved = resolvePassthrough(
      { enabled: { gcloud: true, 'github-cli': true } }, HOME, allExist,
    );
    expect(credentialMountArgs(resolved)).toEqual([
      '-v', `${HOME}/.config/gcloud:/root/.config/gcloud`,
    ]);
    expect(credentialCopyPlan(resolved, 'cez-1')).toEqual([
      ['cp', `${HOME}/.config/gh/hosts.yml`, 'cez-1:/root/.config/gh/hosts.yml'],
    ]);
  });

  it('forwards env vars that are set, and never empty ones', () => {
    const resolved = resolvePassthrough({ enabled: { aws: true } }, HOME, allExist);
    const pairs = credentialEnvPairs(resolved, { AWS_PROFILE: 'dev', AWS_REGION: '' });
    expect(pairs).toContain('AWS_PROFILE=dev');
    // An empty value would SHADOW a credential the container already has.
    expect(pairs.some((p) => p.startsWith('AWS_REGION'))).toBe(false);
  });

  it('supports credentials that are not in the catalog at all', () => {
    const resolved = resolvePassthrough({
      custom: [
        { id: 'vault', hostPath: '.vault-token', guestPath: '/root/.vault-token', mode: 'copy' },
        { id: 'stripe', env: ['STRIPE_API_KEY'] },
      ],
    }, HOME, allExist);
    expect(credentialCopyPlan(resolved, 'c')).toEqual([
      ['cp', `${HOME}/.vault-token`, 'c:/root/.vault-token'],
    ]);
    expect(credentialEnvPairs(resolved, { STRIPE_API_KEY: 'sk_test' })).toEqual(['STRIPE_API_KEY=sk_test']);
  });

  it('a custom credential defaults to copy — the safer of the two', () => {
    const resolved = resolvePassthrough({ custom: [{ id: 'x', hostPath: '.x', guestPath: '/root/.x' }] }, HOME, allExist);
    expect(resolved[0]?.mode).toBe('copy');
  });
});

/** A fake `~/.ssh` with the shapes that actually turn up on a real machine. */
const sshFs = (files: Record<string, string>, dirs: string[] = []): SshFs => ({
  readdir: () => [...Object.keys(files), ...dirs],
  isFile: (path) => !dirs.some((d) => path.endsWith(`/${d}`)),
  head: (path, bytes) => (files[path.split('/').pop() ?? ''] ?? '').slice(0, bytes),
});

const REAL_SSH = {
  // Named by their purpose, not `id_ed25519` — which is the normal case, and
  // the one a name-based guess gets wrong.
  github: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc',
  'github.pub': 'ssh-ed25519 AAAAC3Nz kamil@mac',
  gitlab: '-----BEGIN OPENSSH PRIVATE KEY-----\ndef',
  deploy_prod: '-----BEGIN RSA PRIVATE KEY-----\nghi',
  config: 'Host gl\n  IdentityFile ~/.ssh/gitlab',
  known_hosts: 'gitlab.com ssh-ed25519 AAAA',
  'known_hosts.old': 'stale',
  authorized_keys: 'ssh-rsa AAAA someone@else',
};

describe('ssh keys, one at a time', () => {
  it('finds keys by their CONTENT — people do not name them id_ed25519', () => {
    const found = listSshEntries('/Users/k', sshFs(REAL_SSH, ['agent']));
    expect(found.map((e) => e.name)).toEqual(['config', 'deploy_prod', 'github', 'gitlab', 'known_hosts']);
    expect(found.find((e) => e.name === 'github')).toMatchObject({
      kind: 'private-key',
      // Read from the matching .pub, so the list is identifiable at a glance.
      detail: 'ed25519 · kamil@mac',
    });
  });

  it('never offers authorized_keys, backups, .pub files or directories', () => {
    const names = listSshEntries('/Users/k', sshFs(REAL_SSH, ['agent'])).map((e) => e.name);
    // `authorized_keys` is who may log in to THIS machine — other people's keys,
    // and nothing the agent can use.
    expect(names).not.toContain('authorized_keys');
    expect(names).not.toContain('known_hosts.old');
    // A .pub rides along with its private key; as its own tick it is a decision
    // with no consequence.
    expect(names.some((n) => n.endsWith('.pub'))).toBe(false);
    expect(names).not.toContain('agent');
  });

  it('a missing ~/.ssh is an empty list, not a crash', () => {
    const exploding: SshFs = {
      readdir: () => { throw new Error('ENOENT'); },
      isFile: () => false,
      head: () => '',
    };
    expect(listSshEntries('/Users/k', exploding)).toEqual([]);
  });

  it('passes ONLY the ticked keys — not the directory that holds the rest', () => {
    // The point of the feature: a task that needs the deploy key must not also
    // get the key that reaches production.
    const resolved = resolvePassthrough(
      { enabled: { ssh: { mode: 'mount', keys: ['github', 'known_hosts'] } } }, HOME, allExist,
    );
    const plan = credentialCopyPlan(resolved, 'cez-1');
    expect(plan.map((c) => c[1])).toEqual([
      `${HOME}/.ssh/github`,
      `${HOME}/.ssh/github.pub`,
      `${HOME}/.ssh/known_hosts`,
    ]);
    // Nothing is MOUNTED, so ~/.ssh as a whole never appears.
    expect(credentialMountArgs(resolved)).toEqual([]);
    expect(JSON.stringify(resolved)).not.toContain(`${HOME}/.ssh/gitlab`);
  });

  it('ticked keys are COPIED even when the mode says mount', () => {
    // Narrowing is a containment choice: "may use this key" and "may overwrite
    // this key on my disk" are different grants, and someone ticking one key out
    // of five is asking for the first.
    const resolved = resolvePassthrough(
      { enabled: { ssh: { mode: 'mount', keys: ['github'] } } }, HOME, allExist,
    );
    expect(resolved.every((c) => c.mode === 'copy')).toBe(true);
  });

  it('declares 600 on a private key — ssh REFUSES one that is readable', () => {
    // Not a warning: ssh declines to use the key, and the failure surfaces as
    // "permission denied (publickey)" with nothing pointing back at the copy.
    const resolved = resolvePassthrough({ enabled: { ssh: { keys: ['github'] } } }, HOME, allExist);
    expect(resolved[0]?.perms).toEqual({ file: '600', dir: '700' });
    expect(resolved[0]?.guestPath).toBe('/root/.ssh/github');
  });

  it('ticking nothing still means the whole directory — configs keep their meaning', () => {
    const resolved = resolvePassthrough({ enabled: { ssh: { mode: 'mount' } } }, HOME, allExist);
    expect(credentialMountArgs(resolved)).toEqual(['-v', `${HOME}/.ssh:/root/.ssh`]);
    expect(resolvePassthrough({ enabled: { ssh: { mode: 'mount', keys: [] } } }, HOME, allExist))
      .toEqual(resolved);
  });

  it('refuses a key name that is a path — it becomes a host AND a guest path', () => {
    const resolved = resolvePassthrough(
      { enabled: { ssh: { keys: ['../.aws/credentials', 'a/b', 'github'] } } }, HOME, allExist,
    );
    expect(resolved.map((c) => c.id)).toEqual(['ssh:github', 'ssh:github.pub']);
  });

  it('a ticked key that is gone is skipped with a reason, not mounted as an empty file', () => {
    const resolved = resolvePassthrough({ enabled: { ssh: { keys: ['github'] } } }, HOME, noneExist);
    expect(resolved[0]?.skipped).toMatch(/does not exist/);
    expect(credentialCopyPlan(resolved, 'c')).toEqual([]);
  });
});

describe('the copied ssh config', () => {
  const MAC_CONFIG = [
    'Host github.com',
    '  User git',
    '  IdentityFile ~/.ssh/github',
    'Host azure',
    '  AddKeysToAgent yes',
    '  UseKeychain yes',
  ].join('\n');

  it('neutralizes UseKeychain, which Linux ssh REFUSES to start with', () => {
    // Not ignored, not warned about: "Bad configuration option: usekeychain" and
    // ssh terminates, for every host — including the ones the option had nothing
    // to do with. Apple's own docs tell Mac users to add this line, so plenty of
    // ~/.ssh/config files have it. Verified by running ssh in a container.
    const out = sanitizeSshConfig(MAC_CONFIG);
    expect(out).toContain('# UseKeychain yes');
    expect(out).toMatch(/macOS-only/);
    // Commented, not deleted: it is the operator's file, readable in the
    // container, and a silently vanishing line is worse than an explained one.
    expect(out).toContain('UseKeychain');
  });

  it('leaves every option Linux ssh DOES understand exactly as written', () => {
    const out = sanitizeSshConfig(MAC_CONFIG).split('\n');
    // AddKeysToAgent is portable (OpenSSH 7.2+) — rewriting it would be a
    // behaviour change smuggled in under a compatibility fix.
    expect(out).toContain('  AddKeysToAgent yes');
    expect(out).toContain('  IdentityFile ~/.ssh/github');
    expect(out).toContain('Host github.com');
  });

  it('is applied to config and to nothing else', () => {
    const resolved = resolvePassthrough(
      { enabled: { ssh: { keys: ['config', 'github', 'known_hosts'] } } }, HOME, allExist,
    );
    expect(resolved.find((c) => c.id === 'ssh:config')?.sanitize).toBe('ssh-config');
    // A key file is bytes; rewriting one would corrupt it.
    expect(resolved.find((c) => c.id === 'ssh:github')?.sanitize).toBeUndefined();
    expect(resolved.find((c) => c.id === 'ssh:known_hosts')?.sanitize).toBeUndefined();
  });
});

describe('the GitHub CLI in a container', () => {
  it('copies hosts.yml even when mount was picked — a mount strands on gh’s rewrite and misses a running task', async () => {
    const { resolvePassthrough } = await import('./credential-passthrough.ts');
    const [gh] = resolvePassthrough({ enabled: { 'github-cli': { mode: 'mount' } } }, '/home/u', () => true);
    expect(gh).toMatchObject({ id: 'github-cli', mode: 'copy', guestPath: '/root/.config/gh/hosts.yml' });
  });

  it('keeps the picked mode for a directory', async () => {
    const { resolvePassthrough } = await import('./credential-passthrough.ts');
    const [aws] = resolvePassthrough({ enabled: { aws: { mode: 'copy' } } }, '/home/u', () => true);
    expect(aws?.mode).toBe('copy');
  });

  it('hands the container the host’s gh token — hosts.yml has none when gh keeps it in the Keychain', async () => {
    const { githubTokenEnv, resolvePassthrough } = await import('./credential-passthrough.ts');
    const resolved = resolvePassthrough({ enabled: { 'github-cli': true } }, '/home/u', () => true);
    expect(await githubTokenEnv(resolved, {}, async () => 'gho_host')).toEqual(['GH_TOKEN=gho_host']);
    // Not passed through: nothing, and gh is not even asked.
    let asked = false;
    expect(await githubTokenEnv([], {}, async () => { asked = true; return 'x'; })).toEqual([]);
    expect(asked).toBe(false);
    // An exported token is forwarded as is by credentialEnvPairs; no second one.
    expect(await githubTokenEnv(resolved, { GH_TOKEN: 'exported' }, async () => 'gho_host')).toEqual([]);
    // gh logged out, or missing: the task runs without, never fails.
    expect(await githubTokenEnv(resolved, {}, async () => null)).toEqual([]);
    expect(await githubTokenEnv(resolved, {}, async () => { throw new Error('ENOENT'); })).toEqual([]);
  });
});

describe('the Railway CLI in a container', () => {
  it('mounts ~/.railway by default, so a login or a `railway link` reaches both sides', async () => {
    const { resolvePassthrough } = await import('./credential-passthrough.ts');
    const [railway] = resolvePassthrough({ enabled: { railway: true } }, '/home/u', () => true);
    expect(railway).toMatchObject({
      id: 'railway',
      mode: 'mount',
      hostPath: '/home/u/.railway',
      guestPath: '/root/.railway',
      env: ['RAILWAY_TOKEN', 'RAILWAY_API_TOKEN'],
    });
  });

  it('forwards an exported project or account token, which needs no login on disk', async () => {
    const { credentialEnvPairs, resolvePassthrough } = await import('./credential-passthrough.ts');
    const resolved = resolvePassthrough({ enabled: { railway: true } }, '/home/u', () => false);
    expect(resolved[0]?.skipped).toMatch(/\.railway does not exist/);
    expect(credentialEnvPairs(resolved, { RAILWAY_TOKEN: 'proj-token' })).toEqual(['RAILWAY_TOKEN=proj-token']);
  });
});
