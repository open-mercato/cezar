import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('chosen manager mascot persists through creation and reload', { trace: 'on' }, async ({app,screen,browser})=>{
 await app.open('/manager/new');
 await screen.getByRole('radio','Scout',{exact:true}).tap();
 await screen.getByLabel('What should this manager do?').fill('Watch repositories and summarize progress.');
 await screen.getByRole('button','Create manager',{exact:true}).tap();
 await expect(browser.locator('[data-slot="manager-mascot"][data-mascot="scout"]')).toBeVisible();
 await browser.reload();
 await expect(browser.locator('[data-slot="manager-mascot"][data-mascot="scout"]')).toBeVisible();
 await expect(browser.locator('[data-slot="manager-mascot"] canvas')).toBeVisible();
 await app.screenshot('saved-scout-manager');
});
