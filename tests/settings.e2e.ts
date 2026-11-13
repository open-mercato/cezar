import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';

// The registry in packages/web/src/routes/settings/registry.tsx, minus the redirect-only ids.
// `proof`: what the section's body renders once loaded — its SettingsCard rows by default; the
// three card-less sections name their own landmark.
const CARD_ROWS = '[data-slot="settings-card-rows"]';
const PROJECT_SECTIONS = [
  { id: 'instructions', title: 'Instructions', proof: CARD_ROWS },
  { id: 'tracker', title: 'Issue tracker', proof: CARD_ROWS },
  { id: 'secrets', title: 'Secrets', proof: CARD_ROWS },
  { id: 'webhooks', title: 'Webhooks', proof: CARD_ROWS },
  { id: 'agents', title: 'Agents', proof: CARD_ROWS },
  { id: 'tasks', title: 'Tasks', proof: CARD_ROWS },
  { id: 'agent-config', title: 'Agent config', proof: '[data-slot="agent-config-agents"]' },
  { id: 'worktrees', title: 'Worktrees', proof: CARD_ROWS },
  { id: 'bookmarklets', title: 'Bookmarklets', proof: '[data-slot="settings-content"] h2' },
  { id: 'integrations', title: 'External integrations', proof: '[data-slot="integrations-tabs"]' },
] as const;

const GLOBAL_SECTIONS = [
  { id: 'appearance', title: 'Appearance' },
  { id: 'keyboard', title: 'Keyboard' },
  { id: 'notifications', title: 'Notifications' },
  { id: 'agents', title: 'Agents' },
  { id: 'behaviour', title: 'Behaviour' },
  { id: 'data-privacy', title: 'Data & privacy' },
  { id: 'projects', title: 'Projects' },
] as const;

describe('settings', { tags: ['settings'] }, () => {
  test('the project settings shell: rail, groups, status line, no old footer', async ({ app, screen, browser }) => {
    await app.open('/settings');
    await expect(browser).toHaveURL(/\/p\/[^/]+\/settings$/);

    const nav = screen.getByRole('navigation', 'Settings sections');
    await expect(nav).toBeVisible();
    await expect(nav.getByText('You')).toBeVisible();
    await expect(nav.getByText('Workspace')).toBeVisible();
    await expect(nav.getByText('Project')).toBeVisible();
    await expect(nav.getByText('Stored in ~/.cezar')).toBeVisible();
    await expect(nav.getByRole('link', 'General')).toBeVisible();
    for (const section of PROJECT_SECTIONS) {
      await expect(browser.locator(`[data-project-section="${section.id}"]`)).toBeVisible();
    }
    for (const section of GLOBAL_SECTIONS) {
      await expect(browser.locator(`[data-slot="settings-nav"] [data-section="${section.id}"]`)).toBeVisible();
    }
    await expect(screen.getByRole('button', 'Back')).toBeVisible();

    // The one-line status footer (⌘K + the ⋯ menu) replaced the stacked footer rows.
    const footer = browser.locator('[data-slot="sidebar-footer"]');
    await expect(footer).toBeVisible();
    await expect(footer.getByRole('button', /^Search tasks/)).toBeVisible();
    await expect(footer.getByRole('button', 'More')).toBeVisible();
    await expect(browser.locator('[data-slot="settings-sidebar"] [data-slot="sidebar-footer"] [data-slot="sidebar-health-dot"]')).toHaveCount(0);

    // The project index is the General page: folder, registry facts, Remove.
    await expect(browser.locator('[data-slot="project-general"]')).toBeVisible();
    await expect(browser.locator('[data-slot="project-facts"]')).toBeVisible();
    await expect(screen.getByRole('heading', 'Project', { level: 2 })).toBeVisible();
  });

  test('every project section renders its heading and cards by URL', async ({ app, screen, browser }) => {
    for (const section of PROJECT_SECTIONS) {
      await app.open(`/settings/${section.id}`);
      await expect(browser).toHaveURL(new RegExp(`/p/[^/]+/settings/${section.id}$`));
      await expect(screen.getByRole('heading', section.title, { level: 1 })).toBeVisible();
      await expect(browser.locator(section.proof).first()).toBeVisible({ timeout: 15_000 });
      await expect(browser.locator('[data-slot="settings-nav"] [data-project-section="' + section.id + '"]')).toHaveAttribute('aria-current', 'page');
    }
  });

  test('every global section renders by URL; the index and merged ids redirect', async ({ app, screen, browser }) => {
    await app.open('/settings/global');
    await expect(browser).toHaveURL(/\/settings\/global\/appearance$/);

    for (const section of GLOBAL_SECTIONS) {
      await app.open(`/settings/global/${section.id}`);
      await expect(browser).toHaveURL(new RegExp(`/settings/global/${section.id}$`));
      await expect(screen.getByRole('heading', section.title, { level: 1 })).toBeVisible();
      await expect(browser.locator('[data-slot="settings-card-rows"]').first()).toBeVisible({ timeout: 15_000 });
      await expect(browser.locator('[data-slot="settings-nav"] [data-section="' + section.id + '"]')).toHaveAttribute('aria-current', 'page');
    }

    // A merged page's old id hops to the page it became, with the card anchor.
    await app.open('/settings/global/privacy');
    await expect(browser).toHaveURL(/\/settings\/global\/data-privacy#privacy$/);
    await app.open('/settings/global/resources');
    await expect(browser).toHaveURL(/\/settings\/global\/behaviour#resources$/);
  });

  test('Appearance: the theme control stamps the root and persists across reload', async ({ app, screen, browser }) => {
    await app.open('/settings/global/appearance');
    const theme = screen.getByRole('radiogroup', 'Theme');
    await expect(theme).toBeVisible();
    await expect(theme.getByRole('radio', 'System')).toBeVisible();

    await theme.getByRole('radio', 'Light').tap();
    await expect(theme.getByRole('radio', 'Light')).toBeChecked();
    await expect.poll(() => browser.evaluate(() => document.documentElement.classList.contains('light'))).toBe(true);
    await expect.poll(() => browser.evaluate(() => localStorage.getItem('cez-theme'))).toBe('light');

    await browser.reload();
    await expect(screen.getByRole('radiogroup', 'Theme').getByRole('radio', 'Light')).toBeChecked();
    expect(await browser.evaluate(() => document.documentElement.classList.contains('light'))).toBe(true);

    await screen.getByRole('radiogroup', 'Theme').getByRole('radio', 'Dark').tap();
    await expect(screen.getByRole('radiogroup', 'Theme').getByRole('radio', 'Dark')).toBeChecked();
    await expect.poll(() => browser.evaluate(() => document.documentElement.classList.contains('light'))).toBe(false);
    await expect.poll(() => browser.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark');
  });

  test('Appearance: the usage-gauges toggle is per browser and survives a reload', async ({ app, screen, browser }) => {
    await app.open('/settings/global/appearance');
    const gauges = screen.getByRole('radiogroup', 'Usage gauges');
    await expect(gauges.getByRole('radio', 'Show')).toBeChecked();

    await gauges.getByRole('radio', 'Hide').tap();
    await expect(gauges.getByRole('radio', 'Hide')).toBeChecked();
    await expect.poll(() => browser.evaluate(() => localStorage.getItem('cez-live-usage'))).toBe('off');

    await browser.reload();
    await expect(screen.getByRole('radiogroup', 'Usage gauges').getByRole('radio', 'Hide')).toBeChecked();

    await screen.getByRole('radiogroup', 'Usage gauges').getByRole('radio', 'Show').tap();
    await expect(screen.getByRole('radiogroup', 'Usage gauges').getByRole('radio', 'Show')).toBeChecked();
    await expect.poll(() => browser.evaluate(() => localStorage.getItem('cez-live-usage'))).toBe('on');
  });

  test('Behaviour: an IntegerStepper steps, clamps at its bounds and flashes Saved', async ({ app, screen, browser }) => {
    await app.open('/settings/global/behaviour');
    const field = screen.getByRole('spinbutton', 'Max parallel tasks');
    await expect(field).toBeVisible({ timeout: 15_000 });
    await expect(field).toHaveAttribute('aria-valuemin', '1');
    await expect(field).toHaveAttribute('aria-valuemax', '16');
    const initial = Number(await field.inputValue());
    expect(initial).toBeGreaterThanOrEqual(1);

    const row = browser.locator('[data-slot="form-row"]:has([aria-label="Max parallel tasks"])');
    const saved = browser.locator('[data-slot="form-row"]:has([aria-label="Max parallel tasks"]) [data-slot="saved-indicator"]');
    const next = initial < 16 ? initial + 1 : initial - 1;
    await screen.getByRole('button', initial < 16 ? 'Increase Max parallel tasks' : 'Decrease Max parallel tasks').tap();
    await expect(field).toHaveValue(String(next));
    await expect(saved).toHaveText('Saved', { timeout: 10_000 });
    await expect(row).toHaveAttribute('data-saved', '');
    await browser.reload();
    await expect(screen.getByRole('spinbutton', 'Max parallel tasks')).toHaveValue(String(next), { timeout: 15_000 });

    // Typed values: the top of the range saves and disables the up arrow; past it is refused.
    const again = screen.getByRole('spinbutton', 'Max parallel tasks');
    await again.fill('16');
    await again.press('Enter');
    await expect(again).toHaveValue('16');
    await expect(screen.getByRole('button', 'Increase Max parallel tasks')).toBeDisabled();
    await expect(saved).toHaveText('Saved', { timeout: 10_000 });
    await again.fill('99');
    await expect(again).toHaveAttribute('aria-invalid', 'true');
    await expect(screen.getByText('Enter a whole number from 1 to 16.')).toBeVisible();
    await again.press('Escape');
    await expect(again).toHaveValue('16');
    await again.fill('0');
    await expect(screen.getByText('Enter a whole number from 1 to 16.')).toBeVisible();

    // Put the workspace back the way the run found it.
    await again.fill(String(initial));
    await again.press('Enter');
    await expect(again).toHaveValue(String(initial));
    await expect.poll(async () => {
      const response = await fetch(new URL('/api/v1/workspace/config', app.baseUrl));
      const body = (await response.json()) as { resources: { maxParallel: number } };
      return body.resources.maxParallel;
    }).toBe(initial);
  });

  test('Behaviour: a Select changes a value and flashes Saved', async ({ app, screen, browser }) => {
    await app.open('/settings/global/behaviour');
    const select = screen.getByRole('combobox', 'Autonomous by default');
    await expect(select).toBeVisible({ timeout: 15_000 });
    await expect(select).toHaveText('Inherit environment');

    await select.tap();
    await screen.getByRole('option', 'On').tap();
    await expect(select).toHaveText('On');
    await expect(browser.locator('[data-slot="form-row"]:has([aria-label="Autonomous by default"]) [data-slot="saved-indicator"]')).toHaveText('Saved', { timeout: 10_000 });
    await expect(select).toHaveAttribute('data-value', 'on');

    await browser.reload();
    await expect(screen.getByRole('combobox', 'Autonomous by default')).toHaveText('On', { timeout: 15_000 });

    await screen.getByRole('combobox', 'Autonomous by default').tap();
    await screen.getByRole('option', 'Inherit environment').tap();
    await expect(screen.getByRole('combobox', 'Autonomous by default')).toHaveText('Inherit environment');
  });

  test('Remove project asks first, and Keep it leaves the project registered', async ({ app, screen, browser }) => {
    // The boot project cannot be removed from the cockpit, so a throwaway folder stands in.
    // realpath: macOS answers /private/tmp for /tmp and the registry stores the resolved root.
    const root = realpathSync(mkdtempSync(join(tmpdir(), `cez-e2e-remove-${Date.now()}-`)));
    let projectId: string | null = null;
    try {
      const response = await fetch(new URL('/api/v1/projects', app.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root }),
      });
      expect(response.status).toBe(200);
      const registered = (await response.json()) as { project: { id: string; name: string } };
      projectId = registered.project.id;
      const name = registered.project.name;

      await app.open(`/p/${encodeURIComponent(projectId)}/settings`);
      await expect(screen.getByRole('heading', name, { level: 1 })).toBeVisible();
      const remove = screen.getByRole('button', `Remove ${name} from the workspace — unregisters it, no files are deleted`);
      await expect(remove).toBeEnabled();
      await remove.tap();

      const dialog = screen.getByRole('alertdialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('heading', `Remove ${name} from the workspace?`)).toBeVisible();
      await expect(dialog.getByText('nothing on disk is deleted')).toBeVisible();
      await expect(dialog.getByTestId('remove-project-root')).toHaveText(root);
      const confirm = dialog.getByRole('button', 'Remove from list');
      await expect(confirm).toBeVisible();
      expect(await confirm.getAttribute('data-action')).toBe('projects-confirm-remove');

      await dialog.getByRole('button', 'Keep it').tap();
      await expect(screen.getByRole('alertdialog')).toBeHidden();
      await expect(screen.getByRole('heading', name, { level: 1 })).toBeVisible();

      // Still in the registry, from the server's point of view.
      const list = await fetch(new URL('/api/v1/projects', app.baseUrl));
      const body = (await list.json()) as { projects: Array<{ id: string }> };
      expect(body.projects.map((project) => project.id)).toContain(projectId);
      await app.open('/settings/global/projects');
      await expect(browser.locator(`[data-slot="project-row"][data-project="${projectId}"]`)).toBeVisible();
    } finally {
      if (projectId !== null) {
        await fetch(new URL(`/api/v1/projects/${encodeURIComponent(projectId)}`, app.baseUrl), { method: 'DELETE' });
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Data & privacy: telemetry consent is off and blocked for this server', async ({ app, screen, browser }) => {
    await app.open('/settings/global/data-privacy');
    await expect(screen.getByRole('heading', 'Privacy', { level: 2 })).toBeVisible();
    const consent = screen.getByRole('switch', 'Share usage data');
    await expect(consent).toBeVisible();
    await expect(consent).not.toBeChecked();
    await expect(consent).toBeEnabled();
    // CEZ_TELEMETRY=0 and CEZ_DRY_RUN=1 are both set for the e2e server: the card says so.
    await expect(browser.locator('[data-slot="telemetry-blocked"]')).toContainText(/CEZ_TELEMETRY=0|CEZ_DRY_RUN=1/);
    await expect(screen.getByRole('link', 'Exactly what is collected')).toBeVisible();

    const status = await fetch(new URL('/api/v1/telemetry/consent', app.baseUrl));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ consent: expect.stringMatching(/^(unknown|denied)$/) });
  });

  test('phone: the index is a list of sections and a section carries a way back', async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open('/settings');
    await expect(browser).toHaveURL(/\/p\/[^/]+\/settings$/);

    const cards = browser.locator('[data-slot="settings-index"]');
    await expect(cards).toBeVisible();
    await expect(cards.getByRole('link')).toHaveCount(PROJECT_SECTIONS.length);
    await expect(screen.getByRole('button', 'Open settings menu')).toBeVisible();
    await expect(screen.getByRole('navigation', 'Settings sections')).toBeHidden();

    await browser.locator('[data-slot="settings-index"] [data-section="worktrees"]').tap();
    await expect(browser).toHaveURL(/\/p\/[^/]+\/settings\/worktrees$/);
    const pills = screen.getByRole('navigation', 'Sections of this area');
    await expect(pills).toBeVisible();
    await expect(pills.getByRole('link', '‹ Workspace')).toBeVisible();
    await expect(browser.locator('[data-slot="settings-mobile-bar"]')).toContainText('Worktrees');

    // The pill row's General entry is the way back to the index.
    await pills.getByRole('link', 'General').tap();
    await expect(browser).toHaveURL(/\/p\/[^/]+\/settings$/);
    await expect(cards).toBeVisible();

    // The hamburger opens the same rail as a drawer, with Back inside it.
    await screen.getByRole('button', 'Open settings menu').tap();
    const drawer = screen.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('navigation', 'Settings sections')).toBeVisible();
    await expect(drawer.getByRole('button', 'Back')).toBeVisible();
    await drawer.getByRole('button', 'Close menu').tap();
    await expect(screen.getByRole('dialog')).toBeHidden();
  });

  test('Back leaves settings for the project', async ({ app, screen, browser }) => {
    await app.open('/settings/global/keyboard');
    await screen.getByRole('button', 'Back').tap();
    await expect(browser).toHaveURL(/\/p\/[^/]+\/(tasks|now)?$/);
    await expect(screen.getByRole('navigation', 'Main')).toBeVisible();
  });
});
