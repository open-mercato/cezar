import { expect } from 'e2e';
import type { App, Screen } from 'e2e';
import type { Browser } from '@e2e-dev/web';

/** The run's title; `mock:done` makes the dry-run agent close its session (CEZ:DONE), otherwise
 *  the mock leaves it open at `waiting` forever. */
export const taskTitle = (label: string, markers = 'mock:done') => `E2E ${Date.now()} ${label} ${markers}`.trim();

/** Creates a task from `/new` and lands on its page; answers the run id. */
export async function createMockTask(app: App, screen: Screen, browser: Browser, title: string): Promise<string> {
  await app.open('/new');
  await screen.getByRole('textbox', 'Describe a task for the agent').fill(title);
  await screen.getByRole('button', 'Start task').tap();
  await expect(browser).toHaveURL(/\/p\/[^/]+\/tasks\/[^/]+$/, { timeout: 30_000 });
  return (await browser.url()).split('/tasks/')[1]!;
}

/** The header's status dot carries the attention tone and the status word as its name. */
export const statusDot = (browser: Browser) => browser.locator('[data-slot="run-header"] [data-slot="run-status-dot"]');

/** Waits until the mock run settles with the given status word on the header dot. */
export async function waitForStatus(browser: Browser, label: string) {
  await expect(statusDot(browser)).toHaveAttribute('aria-label', label, { timeout: 60_000 });
}

export async function runStatus(app: App, id: string): Promise<string> {
  const res = await fetch(new URL(`/api/v1/runs/${id}`, app.baseUrl));
  return ((await res.json()) as { status: string }).status;
}

/** A finished mock task: created, closed by the mock, settled as `done`. */
export async function createDoneTask(app: App, screen: Screen, browser: Browser, label: string): Promise<string> {
  const id = await createMockTask(app, screen, browser, taskTitle(label));
  await waitForStatus(browser, 'done');
  return id;
}

/** The one layout the stage shows; the keep-alive layouts beside it stay in the DOM. */
export const ACTIVE_LAYOUT = '[data-slot="workspace-stage"] [data-slot="workspace-layout"][data-active]';
