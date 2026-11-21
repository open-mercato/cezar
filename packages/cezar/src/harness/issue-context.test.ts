import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackerDriver } from '../server/tracker/types.ts';
import type { ForgeDriver } from '../server/forge/types.ts';
import { resolveHarnessIssue } from './issue-context.ts';

const report = { id: 'APP-42', title: 'Dropped message', body: 'Enqueue during flush. Expected delivery, actual loss.', url: 'https://acme.atlassian.net/browse/APP-42', bodyTruncated: false, unsupportedContent: false };
function setup() {
  const getItem = vi.fn(async () => ({ available: true as const, item: report }));
  const trackerDriver = { association: { kind: 'jira', source: { webUrl: 'https://acme.atlassian.net' } }, getItem } as unknown as TrackerDriver;
  const driver = vi.fn(async () => trackerDriver);
  const getIssue = vi.fn(async () => ({ available: true as const, ...report, url: 'https://github.com/acme/app/issues/42' }));
  const forge = vi.fn(async () => ({ getIssue, viewUrl: (_kind: string, number: number) => `https://github.com/acme/app/issues/${number}` }) as unknown as ForgeDriver);
  return { driver, getItem, getIssue, forge, trackerDriver, deps: { tracker: { driver }, forge } };
}

beforeEach(() => vi.stubEnv('CEZ_DRY_RUN', '0'));
afterEach(() => vi.unstubAllEnvs());
describe('host issue context', () => {
  it.each(['APP-42', report.url])('loads the configured tracker report for %s', async (ref) => {
    const h = setup();
    const context = await resolveHarnessIssue('/repo', '/data', ref, h.deps);
    expect(h.driver).toHaveBeenCalledWith('/repo', '/data');
    expect(h.getItem).toHaveBeenCalledWith('APP-42');
    expect(context.text).toContain(report.title);
    expect(context.text).toContain(report.body);
    expect(context.text).toContain(report.url);
    expect(h.forge).not.toHaveBeenCalled();
  });
  it('resolves Linear links through the selected team driver', async () => {
    const h = setup();
    h.driver.mockResolvedValue({ ...h.trackerDriver, association: { ...h.trackerDriver.association, kind: 'linear', source: { id: 'workspace', webUrl: 'https://linear.app/acme' } } });
    h.getItem.mockResolvedValue({ available: true, item: { ...report, url: 'https://linear.app/acme/issue/APP-42/dropped-message' } });
    expect(await resolveHarnessIssue('/repo', '/data', 'https://linear.app/acme/issue/APP-42/dropped-message', h.deps)).toMatchObject({ id: 'APP-42' });
    expect(h.getItem).toHaveBeenCalledWith('APP-42');
    h.getItem.mockClear();
    await expect(resolveHarnessIssue('/repo', '/data', 'https://linear.app/other/issue/APP-42/dropped-message', h.deps)).rejects.toThrow(/does not belong/);
    expect(h.getItem).not.toHaveBeenCalled();
  });
  it('rejects wrong-source links before fetching a report', async () => {
    const h = setup();
    await expect(resolveHarnessIssue('/repo', '/data', 'https://other.atlassian.net/browse/APP-42', h.deps)).rejects.toThrow(/does not belong/);
    expect(h.getItem).not.toHaveBeenCalled();
  });
  it('preserves tracker scope and availability failures instead of falling back to GitHub', async () => {
    const h = setup();
    h.getItem.mockResolvedValue({ available: false, code: 'not_found', reason: 'Issue is outside the selected project.' } as never);
    await expect(resolveHarnessIssue('/repo', '/data', 'APP-42', h.deps)).rejects.toThrow(/outside/);
    h.driver.mockResolvedValue({ available: false, code: 'credentials_missing', reason: 'Reconnect the tracker.' } as never);
    await expect(resolveHarnessIssue('/repo', '/data', '42', h.deps)).rejects.toThrow(/Reconnect/);
    expect(h.forge).not.toHaveBeenCalled();
  });
  it.each(['bodyTruncated', 'unsupportedContent'])('stops when %s makes the report incomplete', async (field) => {
    const h = setup();
    h.getItem.mockResolvedValue({ available: true, item: { ...report, [field]: true } });
    await expect(resolveHarnessIssue('/repo', '/data', 'APP-42', h.deps)).rejects.toThrow(/incomplete/);
  });
  it.each(['42', '#42', 'https://github.com/acme/app/issues/42#issuecomment-1'])('loads a GitHub issue without tracker configuration: %s', async (ref) => {
    const h = setup();
    h.driver.mockResolvedValue({ available: false, code: 'not_configured', reason: 'No tracker.' } as never);
    expect(await resolveHarnessIssue('/repo', '/data', ref, h.deps)).toMatchObject({ id: '42', text: expect.stringContaining('Issue 42: Dropped message') });
    expect(h.getIssue).toHaveBeenCalledWith(42);
  });
  it('does not read a foreign GitHub repository or reinterpret an invalid number', async () => {
    const h = setup();
    h.driver.mockResolvedValue({ available: false, code: 'not_configured', reason: 'No tracker.' } as never);
    for (const ref of ['https://github.com/other/app/issues/42', 'https://evil.test/acme/app/issues/42', '--help', '4e2', '0', '9007199254740992']) {
      await expect(resolveHarnessIssue('/repo', '/data', ref, h.deps)).rejects.toThrow();
    }
    expect(h.getIssue).not.toHaveBeenCalled();
  });
  it('does not perform a lookup in dry-run mode', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const h = setup();
    await expect(resolveHarnessIssue('/repo', '/data', '42', h.deps)).rejects.toThrow(/dry-run/);
    expect(h.driver).not.toHaveBeenCalled();
    expect(h.forge).not.toHaveBeenCalled();
  });
});
