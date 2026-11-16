import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Browser coverage complements the real Swift proxy tests; this is not a shipped iOS binary test.
test('an old cockpit keeps its route and session through offline retry and a single version reload', { trace: 'on', timeout: 90_000 }, async ({ app, browser, screen }) => {
  const base = app.baseUrl;
  if (!base) throw new Error('Cockpit URL required');
  const html = await (await fetch(base)).text();
  const build = /<meta\s+name="cezar-build"\s+content="([^"]+)"/.exec(html)?.[1];
  if (!build) throw new Error('Build identity required');
  const oldPrefix = '/assets/fixture-old/';
  const oldHtml = html.replace(/((?:src|href)=")\/assets\/([^" ]+\.js)"/g, `$1${oldPrefix}$2"`);
  await browser.route(new URL(`${oldPrefix}**`, base).href, async (route) => {
    const path = new URL(route.request.url).pathname.replace(oldPrefix, '/assets/');
    const body = await (await fetch(new URL(path, base))).text();
    await route.fulfill({ contentType: 'text/javascript', body: body.replaceAll(build, 'fixture-old-build') });
  });
  let loads = 0;
  await browser.route(new URL('/manager?reload-test=1', base).href, async (route) => {
    loads += 1;
    await route.fulfill({ contentType: 'text/html', body: loads === 1 ? oldHtml : html, headers: { 'cache-control': 'no-cache' } });
  });
  await browser.addInitScript(() => {
    sessionStorage.setItem('reload-session', sessionStorage.getItem('reload-session') ?? 'kept');
  });
  await app.open('/manager?reload-test=1#kept');
  await browser.setCookies([{ name: 'reload-session', value: 'paired', domain: new URL(base).hostname, path: '/', secure: false, httpOnly: true, sameSite: 'Strict', expires: Math.floor(Date.now() / 1000) + 3600 }]);
  expect((await browser.cookies()).find((cookie) => cookie.name === 'reload-session')?.value).toBe('paired');
  await expect(screen.getByRole('button', 'Reload', { exact: true })).toBeVisible();
  const previousUrl = await browser.url();
  await app.screenshot('stale-banner');

  let probes = 0;
  let offline = true;
  await browser.route(new URL('/', base).href, async (route) => {
    probes += 1;
    await route.fulfill(offline
      ? { status: 502, body: 'Computer offline', headers: { 'cache-control': 'no-store' } }
      : { contentType: 'text/html', body: html, headers: { 'cache-control': 'no-cache' } });
  });
  await screen.getByRole('button', 'Reload', { exact: true }).tap();
  await expect(screen.getByRole('alert')).toContainText('Cannot reach cezar');
  expect(await browser.url()).toBe(previousUrl);
  expect(loads).toBe(1);
  await app.screenshot('reload-offline');

  offline = false;
  await screen.getByRole('button', 'Reload', { exact: true }).tap();
  await expect.poll(() => loads).toBe(2);
  await expect(screen.getByRole('button', 'Reload', { exact: true })).toBeHidden();
  expect(await browser.url()).toBe(previousUrl);
  expect(await browser.evaluate(() => sessionStorage.getItem('reload-session'))).toBe('kept');
  expect((await browser.cookies()).find((cookie) => cookie.name === 'reload-session')?.value).toBe('paired');
  expect(probes).toBe(2);
  await app.screenshot('reload-current');
});
