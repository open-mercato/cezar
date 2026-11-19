// A minimal Chrome DevTools Protocol client over Node's built-in WebSocket, so the store
// screenshots need no npm dependency. Launches headless Chrome, opens pages at a device metric.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function launchChrome() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME_PATH`);
  const profile = mkdtempSync(join(tmpdir(), 'cezar-store-chrome-'));
  const child = spawn(
    CHROME,
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--force-color-profile=srgb', 'about:blank'],
    { stdio: 'ignore', detached: true },
  );
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await sleep(50);
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  // Chrome writes this file; still, connect only to its own loopback DevTools endpoint.
  if (!/^\d{2,5}$/.test(port) || !/^\/devtools\/browser\/[\w-]+$/.test(path)) throw new Error(`unexpected DevToolsActivePort: ${port} ${path}`);
  const browser = await connect(`ws://127.0.0.1:${port}${path}`);
  return {
    browser,
    async close() {
      try {
        await browser.send('Browser.close');
      } catch {
        // already gone
      }
      browser.ws.close();
      for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(50);
      // Its own process group: helpers that outlive the browser go too.
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // all gone
      }
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`));
      else resolve(msg.result);
    } else for (const listener of listeners) listener(msg);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { ws, send, listeners };
}

/** A page at `width`×`height` CSS px and `scale` device px, with touch and a mobile viewport. */
export async function openPage(browser, { width, height, scale, mobile = true, dark = true }) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  const errors = [];
  const onEvent = (msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
  };
  browser.listeners.add(onEvent);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile, screenWidth: width, screenHeight: height });
  if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  // Several pages stay open at once; none should be throttled as a background tab.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.setWebLifecycleState', { state: 'active' });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 1 } });

  const page = {
    errors,
    send,
    /** Runs `fn` (a function or expression string) in the page and returns its JSON value. */
    async evaluate(fn, ...args) {
      const expression = typeof fn === 'function' ? `(${fn})(...${JSON.stringify(args)})` : fn;
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    async addInitScript(source) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source });
    },
    async goto(url) {
      await send('Page.navigate', { url });
      await page.waitFor(() => document.readyState === 'complete', 20000);
    },
    /** Polls `fn` in the page until it returns something truthy. */
    async waitFor(fn, timeout = 15000) {
      const until = Date.now() + timeout;
      for (;;) {
        const value = await page.evaluate(fn).catch(() => undefined);
        if (value) return value;
        if (Date.now() > until) throw new Error(`timed out waiting for ${String(fn).slice(0, 160)}`);
        await sleep(150);
      }
    },
    async front() {
      await send('Page.bringToFront');
    },
    async screenshot() {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
      return Buffer.from(data, 'base64');
    },
    async close() {
      browser.listeners.delete(onEvent);
      await browser.send('Target.closeTarget', { targetId });
    },
  };
  return page;
}

export { sleep };
