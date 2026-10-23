import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isGitlabHost, parseGlabConfigHosts, resetGitlabHostsCache } from './gitlab-hosts.ts';

/** `glab`'s own config, the shape `glab auth login` writes (glab 1.118, 4-space indent). */
const GLAB_CONFIG = `# What protocol to use when performing Git operations.
git_protocol: ssh
# Default GitLab hostname to use.
host: gitlab.com
hosts:
    gitlab.com:
        api_protocol: https
        api_host: gitlab.com
        user: me
        container_registry_domains: gitlab.com,gitlab.com:443,registry.gitlab.com
    gitlab.acme.internal:
        api_protocol: https
        api_host: gitlab.acme.internal
        user: me
no_prompt: false
`;

describe('parseGlabConfigHosts', () => {
  it('reads the host keys under `hosts:` and the top-level default host — nothing nested deeper', () => {
    expect(parseGlabConfigHosts(GLAB_CONFIG)).toEqual(['gitlab.com', 'gitlab.com', 'gitlab.acme.internal']);
  });

  it('follows whatever indent the file uses, and quoted keys', () => {
    expect(parseGlabConfigHosts('hosts:\n  "git.corp.example":\n    user: me\n  other.example:\n    user: me\n')).toEqual([
      'git.corp.example',
      'other.example',
    ]);
  });

  it('stops at the next top-level key, and ignores comments and blank lines', () => {
    expect(parseGlabConfigHosts('hosts:\n    # a comment\n\n    a.example:\n        user: me\nnot_hosts:\n    b.example:\n')).toEqual([
      'a.example',
    ]);
  });

  it('answers nothing for an empty, garbled or host-less file', () => {
    expect(parseGlabConfigHosts('')).toEqual([]);
    expect(parseGlabConfigHosts('{not: [yaml')).toEqual([]);
    expect(parseGlabConfigHosts('git_protocol: ssh\n')).toEqual([]);
  });
});

describe('isGitlabHost', () => {
  let dir: string;
  const saved = { dir: process.env.GLAB_CONFIG_DIR, host: process.env.GITLAB_HOST, gl: process.env.GL_HOST };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-glab-hosts-'));
    process.env.GLAB_CONFIG_DIR = dir;
    delete process.env.GITLAB_HOST;
    delete process.env.GL_HOST;
    resetGitlabHostsCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['GLAB_CONFIG_DIR', saved.dir], ['GITLAB_HOST', saved.host], ['GL_HOST', saved.gl]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetGitlabHostsCache();
  });

  it('knows gitlab.com with no glab config at all, case-insensitively', () => {
    expect(isGitlabHost('gitlab.com')).toBe(true);
    expect(isGitlabHost('GitLab.com')).toBe(true);
    expect(isGitlabHost('gitlab.acme.internal')).toBe(false);
    expect(isGitlabHost(undefined)).toBe(false);
  });

  it('knows every host glab is configured for', () => {
    writeFileSync(join(dir, 'config.yml'), GLAB_CONFIG);
    expect(isGitlabHost('gitlab.acme.internal')).toBe(true);
    expect(isGitlabHost('git.other.internal')).toBe(false);
  });

  it('honors GITLAB_HOST and GL_HOST, as a host or a URL', () => {
    process.env.GITLAB_HOST = 'https://gitlab.acme.internal:8443/';
    process.env.GL_HOST = 'git.corp.example';
    expect(isGitlabHost('gitlab.acme.internal')).toBe(true);
    expect(isGitlabHost('git.corp.example')).toBe(true);
  });

  it('never accepts a host that is not safe to build URLs from', () => {
    writeFileSync(join(dir, 'config.yml'), GLAB_CONFIG);
    expect(isGitlabHost('gitlab.acme.internal/../x')).toBe(false);
    expect(isGitlabHost('gitlab acme')).toBe(false);
  });

  it('caches the read: a config written inside the TTL is seen only after a reset', () => {
    expect(isGitlabHost('gitlab.acme.internal')).toBe(false);
    writeFileSync(join(dir, 'config.yml'), GLAB_CONFIG);
    expect(isGitlabHost('gitlab.acme.internal')).toBe(false);
    resetGitlabHostsCache();
    expect(isGitlabHost('gitlab.acme.internal')).toBe(true);
  });
});
