import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  StoreSchema,
  StoredIssueSchema,
  IssueAnalysisSchema,
  type Store,
  type StoredIssue,
  type StoredComment,
  type IssueAnalysis,
  type IssueDigest,
  type StoreMeta,
} from './store.model.js';
import type { StorePort } from '../ports/store.port.js';

export interface IssueFilter {
  state?: 'open' | 'closed' | 'all';
  hasDigest?: boolean;
}

export class IssueStore {
  private data: Store;
  private filePath: string;
  private port: StorePort | null;
  /** Issue numbers mutated since load/last save. The port-backed save() only
   *  overrides these in the fresh snapshot, so a stale copy of an issue this
   *  run never touched can't clobber a concurrent run's write to it. */
  private dirty = new Set<number>();

  private constructor(data: Store, filePath: string, port: StorePort | null = null) {
    this.data = data;
    this.filePath = filePath;
    this.port = port;
  }

  /**
   * Construct an IssueStore from a custom StorePort (e.g. a Supabase-backed
   * store for the GUI). The port owns persistence; `save()` delegates to it.
   */
  static async fromPort(port: StorePort): Promise<IssueStore> {
    const data = await port.load();
    return new IssueStore(data, '', port);
  }

  /**
   * Build an IssueStore from already-loaded in-memory data (no file, no port) —
   * used by the runner (`packages/runner`), which receives the store snapshot
   * over HTTP and has no Supabase/file of its own. `save()` calls `opts.onSave`
   * with the current data if provided, else is a no-op. Validates via Zod.
   */
  static fromData(data: Store, opts?: { onSave?: (data: Store) => Promise<void> }): IssueStore {
    const parsed = StoreSchema.parse(data);
    const onSave = opts?.onSave;
    const port: StorePort = {
      load: async () => parsed,
      save: async (d) => {
        if (onSave) await onSave(d);
      },
    };
    return new IssueStore(parsed, '', port);
  }

  static async init(storePath: string, meta: { owner: string; repo: string }): Promise<IssueStore> {
    const filePath = join(storePath, 'store.json');
    const data: Store = {
      meta: {
        owner: meta.owner,
        repo: meta.repo,
        lastSyncedAt: null,
        fullSyncedAt: null,
        totalFetched: 0,
        version: 1,
        orgMembers: [],
        orgMembersFetchedAt: null,
      },
      issues: [],
    };
    const store = new IssueStore(data, filePath);
    await store.save();
    return store;
  }

  static async load(storePath: string): Promise<IssueStore> {
    const filePath = join(storePath, 'store.json');
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const data = StoreSchema.parse(parsed);
    return new IssueStore(data, filePath);
  }

  static async loadOrNull(storePath: string): Promise<IssueStore | null> {
    try {
      return await IssueStore.load(storePath);
    } catch {
      return null;
    }
  }

  async save(): Promise<void> {
    if (this.port) {
      // Re-read before save so concurrent runs (two triage/autofix jobs sharing
      // a workspace) don't clobber each other's writes with a stale snapshot.
      // Shallow-merge meta and replace per-issue, preserving any issues only the
      // fresh copy has (written by another in-flight run since we loaded).
      let toSave = this.data;
      try {
        const fresh = await this.port.load();
        const byNumber = new Map(fresh.issues.map((i) => [i.number, i]));
        for (const issue of this.data.issues) {
          if (this.dirty.has(issue.number) || !byNumber.has(issue.number)) {
            byNumber.set(issue.number, issue);
          }
        }
        toSave = {
          meta: { ...fresh.meta, ...this.data.meta },
          issues: Array.from(byNumber.values()),
        };
        this.data = toSave;
      } catch {
        // If the re-read fails, fall back to writing our own snapshot rather
        // than dropping the save entirely.
      }
      await this.port.save(toSave);
      this.dirty.clear();
      return;
    }
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    const json = JSON.stringify(this.data, null, 2);
    await writeFile(tmpPath, json, 'utf-8');
    try {
      await rename(tmpPath, this.filePath);
    } catch (error) {
      await unlink(tmpPath).catch(() => {});
      throw error;
    }
  }

  upsertIssue(issue: Omit<StoredIssue, 'digest' | 'analysis' | 'comments' | 'commentsFetchedAt'>): {
    action: 'created' | 'updated' | 'unchanged';
    stateChanged?: boolean;
  } {
    const existing = this.data.issues.find((i) => i.number === issue.number);
    if (!existing) {
      const full = StoredIssueSchema.parse({ ...issue, digest: null, analysis: {} });
      this.data.issues.push(full);
      this.dirty.add(issue.number);
      return { action: 'created' };
    }

    // The schema defaults assignees to []; guard the raw input the same way.
    const incomingAssignees = issue.assignees ?? [];
    const stateChanged = existing.state !== issue.state;
    const commentCountChanged = existing.commentCount !== issue.commentCount;
    const assigneesChanged =
      existing.assignees.length !== incomingAssignees.length ||
      existing.assignees.some((a, i) => a !== incomingAssignees[i]);

    if (existing.contentHash !== issue.contentHash) {
      existing.title = issue.title;
      existing.body = issue.body;
      existing.state = issue.state;
      existing.labels = issue.labels;
      existing.assignees = incomingAssignees;
      existing.author = issue.author;
      existing.updatedAt = issue.updatedAt;
      existing.htmlUrl = issue.htmlUrl;
      existing.contentHash = issue.contentHash;
      existing.commentCount = issue.commentCount;
      existing.reactions = issue.reactions;
      // Clear digest when content changes — needs re-digesting
      existing.digest = null;
      // Invalidate comments when comment count changes
      if (commentCountChanged) {
        existing.commentsFetchedAt = null;
      }
      this.dirty.add(issue.number);
      return { action: 'updated', stateChanged };
    }

    // Update mutable fields that don't affect content hash
    existing.state = issue.state;
    existing.labels = issue.labels;
    existing.assignees = incomingAssignees;
    // Invalidate comments when comment count changes
    if (commentCountChanged) {
      existing.commentsFetchedAt = null;
    }
    existing.commentCount = issue.commentCount;
    existing.reactions = issue.reactions;
    const updated = stateChanged || commentCountChanged || assigneesChanged;
    if (updated) this.dirty.add(issue.number);
    return {
      action: updated ? 'updated' : 'unchanged',
      stateChanged,
    };
  }

  setDigest(issueNumber: number, digest: IssueDigest): void {
    const issue = this.data.issues.find((i) => i.number === issueNumber);
    if (!issue) throw new Error(`Issue #${issueNumber} not found in store`);
    issue.digest = digest;
    this.dirty.add(issueNumber);
  }

  setComments(issueNumber: number, comments: StoredComment[]): void {
    const issue = this.data.issues.find((i) => i.number === issueNumber);
    if (!issue) throw new Error(`Issue #${issueNumber} not found in store`);
    issue.comments = comments;
    issue.commentsFetchedAt = new Date().toISOString();
    this.dirty.add(issueNumber);
  }

  setAnalysis(issueNumber: number, analysis: Partial<IssueAnalysis>): void {
    const issue = this.data.issues.find((i) => i.number === issueNumber);
    if (!issue) throw new Error(`Issue #${issueNumber} not found in store`);
    issue.analysis = { ...issue.analysis, ...analysis };
    this.dirty.add(issueNumber);
  }

  getIssues(filter: IssueFilter = {}): StoredIssue[] {
    let result = this.data.issues;

    if (filter.state && filter.state !== 'all') {
      result = result.filter((i) => i.state === filter.state);
    }

    if (filter.hasDigest === true) {
      result = result.filter((i) => i.digest !== null);
    } else if (filter.hasDigest === false) {
      result = result.filter((i) => i.digest === null);
    }

    return result;
  }

  getIssue(number: number): StoredIssue | undefined {
    return this.data.issues.find((i) => i.number === number);
  }

  getMeta(): StoreMeta {
    return this.data.meta;
  }

  updateMeta(updates: Partial<StoreMeta>): void {
    Object.assign(this.data.meta, updates);
  }

  getAllData(): Store {
    return this.data;
  }
}
