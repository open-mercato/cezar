import type { App, Screen } from 'e2e'
import type { Browser } from '@e2e-dev/web'
import { expect } from 'e2e'

/** A run-unique task title, so replays and parallel runs never match each other's rows. */
export function taskTitle(label: string): string {
  return `E2E ${Date.now()} ${label}`
}

/** The task page's status dot once the mock agent has stopped: the dry-run agent ends its
 *  first pass by asking a question (`needs you`); a run that lands at the review gate reads
 *  `needs review`, a plain finish `done`. */
export const SETTLED_STATUS = /^(done|needs review|needs you)$/

/** The open task page's status word (`[data-slot="run-status-dot"]`'s accessible label). */
export function readRunStatus(browser: Browser): Promise<string | null> {
  return browser.evaluate(
    () => document.querySelector('[data-slot="run-status-dot"]')?.getAttribute('aria-label') ?? null,
  ) as Promise<string | null>
}

/** Polls the open task page until its status matches `pattern`; returns the status read. */
export async function waitForRunStatus(browser: Browser, pattern: RegExp, timeout = 90_000): Promise<string> {
  await expect.poll(() => readRunStatus(browser), { timeout }).toMatch(pattern)
  return (await readRunStatus(browser)) ?? ''
}

export function waitForRunToSettle(browser: Browser, timeout = 90_000): Promise<string> {
  return waitForRunStatus(browser, SETTLED_STATUS, timeout)
}

/**
 * Starts a mock (`CEZ_DRY_RUN=1`) quick-task from `/new` and waits on its task page until the
 * run has settled. Returns the run id, the settled status label and the project prefix.
 */
export async function createMockTask(
  app: App,
  screen: Screen,
  browser: Browser,
  title: string,
): Promise<{ runId: string; status: string; prefix: string }> {
  await app.open('/new')
  await screen.getByRole('textbox', 'Describe a task for the agent').fill(title)
  await screen.getByRole('button', 'Start task').tap()
  await browser.waitForURL(/\/p\/[^/]+\/tasks\/[^/?#]+$/, { timeout: 30_000 })
  const url = await browser.url()
  const match = /(\/p\/[^/?#]+)\/tasks\/([^/?#]+)$/.exec(url)
  if (!match) throw new Error(`no run id in ${url}`)
  const status = await waitForRunToSettle(browser)
  return { runId: match[2], status, prefix: match[1] }
}

/**
 * The active project's scope prefix (`/p/repo-<port>`), read from where `/` redirects on a
 * fresh context. The flat `/tasks` is the cross-project "All tasks" page and the flat `/`
 * resumes the last location once one is stored, so project pages are opened with the prefix.
 */
export async function projectPrefix(app: App, browser: Browser): Promise<string> {
  await app.open('/')
  await browser.waitForURL(/\/p\/[^/]+/)
  const match = /\/p\/[^/?#]+/.exec(await browser.url())
  if (!match) throw new Error(`no project scope in ${await browser.url()}`)
  return match[0]
}

/**
 * Answers the project's run list with no runs, so a page's empty state can be asserted
 * whatever earlier tests (or other files on the same server) created. GET only — a task
 * started under the stub still reaches the server. Both spellings of the list: the boot
 * project answers under the unscoped alias as well as under `/p/:projectId`.
 */
export async function stubNoRuns(browser: Browser): Promise<void> {
  await browser.route(/\/api\/v1\/(p\/[^/]+\/)?runs(\?.*)?$/, async (route) => {
    if (route.request.method !== 'GET') return route.continue()
    return route.fulfill({ json: [] })
  })
  // The live stream would patch other workers' runs straight into the cache: serve it empty, so
  // the page stays at "no runs" however busy the shared server is.
  await browser.route(/\/api\/v1\/(p\/[^/]+\/)?workspace\/events(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
  )
}

/** The order of the task-table rows, newest first, as run ids. */
export async function tableRowOrder(browser: Browser): Promise<string[]> {
  return browser.evaluate(
    `Array.from(document.querySelectorAll('[data-slot="task-table-row"]')).map((row) => row.getAttribute('data-run-id'))`,
  ) as Promise<string[]>
}

/** `before` sits above `after` in the table — a relative check, because other files on the same
 *  server add rows of their own above and below. */
export async function expectRowOrder(browser: Browser, before: string, after: string): Promise<void> {
  await expect
    .poll(async () => {
      const ids = await tableRowOrder(browser)
      const a = ids.indexOf(before)
      const b = ids.indexOf(after)
      return a >= 0 && b >= 0 && a < b
    }, { timeout: 10_000 })
    .toBe(true)
}
