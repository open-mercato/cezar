import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';

/**
 * The composer's own behaviour, on `/new` and in a task thread: the `/` skill menu, the `@`
 * file-mention menu, attachments (picker and paste), and draft persistence across a reload.
 */

const PROMPT = 'Describe a task for the agent';
const PIXEL = 'tests/fixtures/e2e-pixel.png';

/** The fixture repo this run's server was booted against (`e2e.config.ts` keys it by port). */
function fixtureRepo(baseUrl: string | undefined): string {
  const port = new URL(baseUrl ?? 'http://127.0.0.1:0').port;
  return resolve(`.e2e/fixtures/repo-${port}`);
}

/** Two project skills with a prefix no global skill shares, so the `/` list is predictable. */
function seedSkills(repo: string): void {
  mkdirSync(join(repo, '.ai/skills'), { recursive: true });
  writeFileSync(join(repo, '.ai/skills/zzalpha-e2e.md'), '---\ndescription: Alpha playbook for the e2e suite\n---\n\nDo alpha.\n');
  writeFileSync(join(repo, '.ai/skills/zzbeta-e2e.md'), '---\ndescription: Beta playbook for the e2e suite\n---\n\nDo beta.\n');
}

/** A synthetic paste: the only clipboard a headless test can fill deterministically. */
const PASTE_FILE = `(name) => {
  const el = document.querySelector('[data-slot="composer"] textarea');
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' }));
  const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event.defaultPrevented;
}`;
const PASTE_TEXT = `(text) => {
  const el = document.querySelector('[data-slot="composer"] textarea');
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event.defaultPrevented;
}`;

describe('composer', { tags: ['composer'] }, () => {
  test('/ opens the skill menu, arrows move the highlight, Escape closes it', async ({ app, screen }) => {
    seedSkills(fixtureRepo(app.baseUrl));
    await app.open('/new');
    const prompt = screen.getByRole('textbox', PROMPT);
    await prompt.pressSequentially('Please run /zz');
    const alpha = screen.getByRole('option').filter({ hasText: 'zzalpha-e2e' });
    const beta = screen.getByRole('option').filter({ hasText: 'zzbeta-e2e' });
    await expect(alpha).toBeVisible();
    await expect(beta).toBeVisible();
    await expect(alpha).toContainText('Alpha playbook');
    await expect(alpha).toHaveAttribute('aria-selected', 'true');
    await prompt.press('ArrowDown');
    await expect(beta).toHaveAttribute('aria-selected', 'true');
    await expect(alpha).toHaveAttribute('aria-selected', 'false');
    await prompt.press('ArrowUp');
    await expect(alpha).toHaveAttribute('aria-selected', 'true');
    await prompt.press('Escape');
    await expect(alpha).toBeHidden();
    // Escape kept the draft and only closed the menu.
    await expect(prompt).toHaveValue('Please run /zz');
  });

  test('Enter inserts the highlighted skill at the caret', async ({ app, screen }) => {
    seedSkills(fixtureRepo(app.baseUrl));
    await app.open('/new');
    const prompt = screen.getByRole('textbox', PROMPT);
    await prompt.pressSequentially('Please run /zzb');
    await expect(screen.getByRole('option').filter({ hasText: 'zzbeta-e2e' })).toHaveAttribute('aria-selected', 'true');
    await prompt.press('Enter');
    await expect(prompt).toHaveValue('Please run /zzbeta-e2e ');
    await expect(screen.getByRole('option')).toHaveCount(0);
    await expect(prompt).toBeFocused();
  });

  test('@ opens the file-mention menu in a task thread and Escape closes it', async ({ app, screen, browser }) => {
    await app.open('/new');
    await screen.getByRole('textbox', PROMPT).fill(`E2E ${Date.now()} mention menu`);
    await screen.getByRole('button', 'Start task').tap();
    await expect(browser).toHaveURL(/\/p\/[^/]+\/tasks\/[^/?]+/, { timeout: 15_000 });
    // No CEZ:DONE in the mock's reply: the run parks at `waiting`, where the thread composer is live.
    await expect(screen.getByRole('button', 'Send')).toBeVisible({ timeout: 60_000 });
    const reply = screen.getByPlaceholder('Reply — / for skills, @ for files…');
    await expect(reply).toBeEnabled({ timeout: 60_000 });
    await reply.pressSequentially('Look at @');
    const menu = screen.getByRole('listbox');
    await expect(menu).toBeVisible();
    // The dry-run mock never edits a file, so the menu is honest about the empty session.
    await expect(menu).toContainText(/No files seen in this session yet|src\//);
    await reply.press('Escape');
    await expect(menu).toBeHidden();
    await expect(reply).toHaveValue('Look at @');
  });

  test('the attachment control attaches a picked image and the thumbnail removes it', async ({ app, screen, browser }) => {
    await app.open('/new');
    await expect(screen.getByRole('button', 'Attach files')).toBeEnabled();
    await browser.locator('[data-slot="composer"] input[type="file"]').setInputFiles([PIXEL]);
    const thumb = screen.getByRole('button', 'Remove e2e-pixel.png');
    await expect(thumb).toBeVisible();
    // An attachment alone is a sendable draft.
    await expect(screen.getByRole('button', 'Start task')).toBeEnabled();
    await thumb.tap();
    await expect(thumb).toBeHidden();
    await expect(screen.getByRole('button', 'Start task')).toBeDisabled();
  });

  test('pasting a file attaches it; pasting plain text is left to the browser', async ({ app, screen, browser }) => {
    await app.open('/new');
    const prompt = screen.getByRole('textbox', PROMPT);
    await prompt.fill('Pasted: ');
    const took = await browser.evaluate(PASTE_FILE, 'shot.png');
    expect(took).toBe(true);
    // A clipboard image's name is the browser's invention, so the composer gives it its own.
    await expect(screen.getByRole('button', 'Remove pasted image')).toBeVisible();
    const swallowed = await browser.evaluate(PASTE_TEXT, 'plain words');
    expect(swallowed).toBe(false);
    await expect(screen.getByRole('button', /^Remove /)).toHaveCount(1);
    await expect(prompt).toHaveValue('Pasted: ');
  });

  test('the /new draft survives a reload', async ({ app, screen, browser }) => {
    await app.open('/new');
    const text = `E2E ${Date.now()} draft survives`;
    await screen.getByRole('textbox', PROMPT).fill(text);
    await browser.reload();
    await expect(screen.getByRole('textbox', PROMPT)).toHaveValue(text, { timeout: 15_000 });
    await screen.getByRole('textbox', PROMPT).clear();
    await browser.reload();
    await expect(screen.getByRole('textbox', PROMPT)).toHaveValue('', { timeout: 15_000 });
  });

  test('a thread reply draft comes back after a reload', async ({ app, screen, browser }) => {
    await app.open('/new');
    await screen.getByRole('textbox', PROMPT).fill(`E2E ${Date.now()} thread draft`);
    await screen.getByRole('button', 'Start task').tap();
    await expect(browser).toHaveURL(/\/p\/[^/]+\/tasks\/[^/?]+/, { timeout: 15_000 });
    const reply = screen.getByPlaceholder('Reply — / for skills, @ for files…');
    await expect(reply).toBeEnabled({ timeout: 60_000 });
    const text = `unsent reply ${Date.now()}`;
    const saved = browser.waitForResponse(/\/drafts?\//, { timeout: 15_000 });
    await reply.fill(text);
    await saved;
    await browser.reload();
    await expect(screen.getByPlaceholder('Reply — / for skills, @ for files…')).toHaveValue(text, { timeout: 20_000 });
  });
});
