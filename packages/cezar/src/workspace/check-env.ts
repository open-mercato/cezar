import { randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkEnvNameIssue, checkEnvValueIssue } from '@open-mercato/cezar-contract';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';
import { PROJECT_ID_RE } from './config.ts';

/**
 * Project check credentials (spec `2026-10-06-agentic-e2e-checks` Phase 1).
 *
 * One dotenv file per project at `~/.cezar/check-env/<projectId>.env`, handed to a workflow's
 * CHECK steps only. The values never enter `process.env`, so `buildChildEnv`'s prefix matching
 * can never pass one to an agent backend — the leak the old "export the key before starting
 * cezar" advice caused, which silently switched Claude Code and Codex to API billing.
 *
 * Same write discipline as `TrackerConnections`: a `0700` directory with a `*` `.gitignore`,
 * `0600` files, `O_NOFOLLOW` bounded reads, atomic tmp/rename writes, a cross-process mkdir lock
 * for read-modify-write, and `assertCezarHomeWriteIsSandboxed`. Not an OS-user boundary.
 *
 * A project slug can be handed to another repository after the first is removed from the
 * registry, so each file records the root it belongs to; a file whose recorded root is not the
 * asking project's reads as empty instead of handing one repo's keys to another.
 */

/** A file larger than this is not one this store wrote. Bounded read, like the tracker store. */
const FILE_MAX_BYTES = 256 * 1024;
const ROOT_LINE = '# root: ';

export class CheckEnvError extends Error {}

/**
 * A read of one project's store. `skipped` is set only when a store the user DID write could
 * not be used — bad modes, a symlink, a corrupt file, or a recorded root that is not this
 * project's. Reading as `{}` is the right degradation (a corrupt store must never stop runs),
 * but doing it silently left the user no way to tell "I never stored it" from "cezar ignored
 * what I stored": the credential is write-only, so there is nothing to inspect and compare.
 * The caller turns this into one note on the run.
 */
export interface CheckEnvRead {
  values: Record<string, string>;
  skipped?: string;
}

export class CheckEnv {
  private readonly directory: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.directory = join(cezarHomeDir(env), 'check-env');
  }

  /** Stored names, sorted. Absent or unreadable storage is an empty list, never a throw. */
  async names(projectId: string, root: string): Promise<string[]> {
    return Object.keys(await this.values(projectId, root)).sort();
  }

  /**
   * The project's check credentials, read fresh. Resolved once per check execution, so an edit
   * applies to the next check rather than one already running. Every failure reads as `{}`: a
   * check without its credential fails on its own terms, and a corrupt store must not stop runs.
   */
  async values(projectId: string, root: string): Promise<Record<string, string>> {
    return (await this.read(projectId, root)).values;
  }

  /** `values()` plus the reason a present-but-unusable store was skipped. See `CheckEnvRead`. */
  async read(projectId: string, root: string): Promise<CheckEnvRead> {
    if (!PROJECT_ID_RE.test(projectId)) return { values: {} };
    let text: string;
    try {
      await this.checkDirectory();
      text = await this.readFile(this.file(projectId));
    } catch (error) {
      // No directory and no file are the ordinary "nothing stored" cases and say nothing. Every
      // other failure — a loosened mode, a symlink (`ELOOP` from `O_NOFOLLOW`), an oversized
      // file — is a store that exists and was not used.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { values: {} };
      return { values: {}, skipped: 'the store is unreadable — check the modes on ~/.cezar/check-env (0700 dir, 0600 file)' };
    }
    const parsed = parseCheckEnv(text);
    const owner = await canonicalRoot(root);
    if (parsed.root !== owner) {
      return { values: {}, skipped: `the store belongs to another project root (${parsed.root ?? 'none recorded'}), not ${owner}` };
    }
    return { values: parsed.values };
  }

  async set(projectId: string, root: string, name: string, value: string): Promise<void> {
    const issue = checkEnvNameIssue(name) ?? checkEnvValueIssue(value);
    if (issue) throw new CheckEnvError(issue);
    await this.update(projectId, root, (values) => {
      values[name] = value;
      return true;
    });
  }

  /** Remove `name`. `false` when it was not stored — the route answers 404. */
  async unset(projectId: string, root: string, name: string): Promise<boolean> {
    return this.update(projectId, root, (values) => {
      if (!(name in values)) return false;
      delete values[name];
      return true;
    });
  }

  private file(projectId: string): string {
    return join(this.directory, `${projectId}.env`);
  }

  private async update(
    projectId: string,
    root: string,
    mutate: (values: Record<string, string>) => boolean,
  ): Promise<boolean> {
    if (!PROJECT_ID_RE.test(projectId)) throw new CheckEnvError('invalid project id');
    const owner = await canonicalRoot(root);
    await this.prepare();
    return this.locked(projectId, async () => {
      let values: Record<string, string> = {};
      try {
        const parsed = parseCheckEnv(await this.readFile(this.file(projectId)));
        // A file left by another root is that root's, and that root is gone from this slug:
        // the first write by the slug's new owner starts it over instead of inheriting it.
        if (parsed.root === owner) values = parsed.values;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!mutate(values)) return false;
      await this.save(this.file(projectId), serializeCheckEnv(owner, values));
      return true;
    });
  }

  private async checkDirectory(): Promise<void> {
    const directory = await fs.lstat(this.directory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (process.platform !== 'win32' && (directory.mode & 0o077) !== 0)
    ) {
      throw new CheckEnvError('Invalid check credential directory');
    }
  }

  private async prepare(): Promise<void> {
    assertCezarHomeWriteIsSandboxed(this.directory);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.checkDirectory();
    await this.save(
      join(this.directory, '.gitignore'),
      '# Managed private check credentials; never commit this directory.\n*\n',
    );
  }

  private async readFile(path: string): Promise<string> {
    const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size > FILE_MAX_BYTES ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      ) {
        throw new CheckEnvError('Invalid check credential file');
      }
      // Bound the actual read, too: the file can grow after fstat.
      const buffer = Buffer.alloc(FILE_MAX_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > FILE_MAX_BYTES) throw new CheckEnvError('Invalid check credential file');
      return buffer.subarray(0, offset).toString('utf8');
    } finally {
      await file.close();
    }
  }

  private async save(path: string, text: string): Promise<void> {
    assertCezarHomeWriteIsSandboxed(path);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, path);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  /** Atomic mkdir serializes cockpit/CLI read-modify-writes. Never steal from a live owner. */
  private async locked<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const lock = join(this.directory, `${projectId}.lock`);
    const owner = join(lock, String(process.pid));
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.mkdir(lock, { mode: 0o700 });
        await fs.writeFile(owner, '', { flag: 'wx', mode: 0o600 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 200) throw error;
        const age = await fs.lstat(lock).catch(() => null);
        if (!age) continue;
        const owners = await fs.readdir(lock).catch(() => []);
        if (owners.length === 1 && /^[1-9][0-9]*$/.test(owners[0]!)) {
          try {
            process.kill(Number(owners[0]), 0);
          } catch (killError) {
            if ((killError as NodeJS.ErrnoException).code === 'ESRCH') {
              // Exclusive unlink elects one reaper.
              try {
                await fs.unlink(join(lock, owners[0]!));
                await fs.rmdir(lock);
              } catch {}
            }
          }
        } else if (owners.length === 0 && Date.now() - age.mtimeMs > 60_000) {
          await fs.rmdir(lock).catch(() => {});
        }
        await new Promise((done) => setTimeout(done, 10));
      }
    }
    try {
      return await action();
    } finally {
      await fs.unlink(owner).catch(() => {});
      await fs.rmdir(lock).catch(() => {});
    }
  }
}

async function canonicalRoot(root: string): Promise<string> {
  try {
    return await fs.realpath(root);
  } catch {
    return resolve(root);
  }
}

/**
 * `NAME=value` lines. No interpolation, no `export`, and no quote processing beyond ONE optional
 * pair of surrounding quotes. Lines this store would never write — unknown shapes, refused names —
 * are skipped rather than trusted.
 */
export function parseCheckEnv(text: string): { root: string | undefined; values: Record<string, string> } {
  let root: string | undefined;
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (line.startsWith(ROOT_LINE)) {
      root = line.slice(ROOT_LINE.length);
      continue;
    }
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq);
    if (checkEnvNameIssue(name)) continue;
    let value = line.slice(eq + 1);
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return { root, values };
}

/** Every value is written inside one pair of double quotes, so the reader's single strip is exact. */
export function serializeCheckEnv(root: string, values: Record<string, string>): string {
  const lines = [
    '# cezar check credentials — handed to this project\'s check steps only, never to agents.',
    '# Managed by cezar: edit with `cezar check-env` or Settings → Check credentials.',
    `${ROOT_LINE}${root}`,
  ];
  for (const name of Object.keys(values).sort()) lines.push(`${name}="${values[name]}"`);
  return `${lines.join('\n')}\n`;
}
