import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';

// The catalog is never empty: cezar ships built-in skills (`create-cezar-automation`), and this
// machine's ~/.agents/skills and ~/.claude/skills are discovered too.
describe('skills', { tags: ['skills'] }, () => {
  test('the catalog opens with its header, search box and tools', async ({ app, screen, browser }) => {
    await app.open('/skills');
    await expect(browser).toHaveURL(/\/p\/[^/]+\/skills/);
    await expect(screen.getByRole('heading', 'Skills', { level: 1 })).toBeVisible();
    await expect(screen.getByText('Markdown playbooks agents can follow.')).toBeVisible();
    await expect(screen.getByRole('textbox', 'Filter skills')).toBeVisible();
    await expect(screen.getByRole('button', 'Details')).toHaveAttribute('aria-pressed', 'false');
    await expect(screen.getByRole('button', 'Refresh')).toBeVisible();
  });

  test('built-in skills are discovered and explain their source', async ({ app, screen }) => {
    await app.open('/skills');
    await expect(screen.getByRole('link', /^create-cezar-automation /)).toBeVisible();
    await expect(screen.getByText('builtin').first()).toHaveAccessibleName(
      'Built into Cezar rather than installed from a skill repository.',
    );
    // A built-in is always on: its row carries no activation switch at all.
    await expect(
      screen.getByRole('listitem').filter({ hasText: 'create-cezar-automation' }).last().getByRole('switch'),
    ).toHaveCount(0);
  });

  test('the search box filters the list and says when nothing matches', async ({ app, screen }) => {
    await app.open('/skills');
    const filter = screen.getByRole('textbox', 'Filter skills');
    await filter.fill('create-cezar-automation');
    await expect(screen.getByRole('link', /^create-cezar-automation /)).toBeVisible();
    await expect(screen.getByRole('link', /^change-impact /)).toHaveCount(0);
    await filter.fill(`zz-no-such-skill-${Date.now()}`);
    await expect(screen.getByText('(no skills match)')).toBeVisible();
    await filter.clear();
    await expect(screen.getByRole('link', /^change-impact /)).toBeVisible();
  });

  test('picking a skill previews it beside the catalog', async ({ app, screen, browser }) => {
    await app.open('/skills');
    await screen.getByRole('link', /^create-cezar-automation /).tap();
    await expect(browser).toHaveURL(/\/skills\?skill=create-cezar-automation$/);
    await expect(screen.getByRole('heading', 'create-cezar-automation')).toBeVisible();
    await expect(screen.getByRole('heading', 'Content')).toBeVisible();
  });

  test('details toggles the long descriptions', async ({ app, screen }) => {
    await app.open('/skills');
    await screen.getByRole('button', 'Details').tap();
    await expect(screen.getByRole('button', 'Details')).toHaveAttribute('aria-pressed', 'true');
    await screen.getByRole('button', 'Details').tap();
    await expect(screen.getByRole('button', 'Details')).toHaveAttribute('aria-pressed', 'false');
  });

  test('phone width shows one pane at a time with a way back', async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open('/skills');
    await expect(screen.getByRole('textbox', 'Filter skills')).toBeVisible();
    await screen.getByRole('link', /^create-cezar-automation /).tap();
    await expect(screen.getByRole('heading', 'create-cezar-automation')).toBeVisible();
    await expect(screen.getByRole('textbox', 'Filter skills')).toBeHidden();
    await screen.getByRole('link', 'Back to skills').tap();
    await expect(screen.getByRole('textbox', 'Filter skills')).toBeVisible();
  });
});
