// Store screenshots, the Play feature graphic and the Play hi-res icon, all from real UI in
// headless Chrome (cdp.mjs, no npm dependency). See ../screenshots/README.md.
//   node packages/mobile/store/scripts/screenshots.mjs                 everything
//   node packages/mobile/store/scripts/screenshots.mjs --only graphics,connect,cockpit
//   node packages/mobile/store/scripts/screenshots.mjs --connect DIR   connect screen from DIR
//   node packages/mobile/store/scripts/screenshots.mjs --ios-pairing   iOS shows relay pairing too
// The cockpit scenes boot this repo's built cezar (packages/cezar/dist + web/dist) with
// CEZ_DRY_RUN=1 in a throwaway HOME, CEZ_HOME and demo project, and stop it afterwards.
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { launchChrome, openPage, sleep } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const store = join(here, '..');
const mobile = join(store, '..');
const repo = join(mobile, '../..');

const { values: args } = parseArgs({
  options: {
    only: { type: 'string', default: 'graphics,connect,cockpit' },
    connect: { type: 'string', default: join(mobile, 'connect') },
    port: { type: 'string', default: '0' },
    keep: { type: 'boolean', default: false },
    'ios-pairing': { type: 'boolean', default: false },
  },
});
const only = new Set(args.only.split(','));

// CSS viewport × devicePixelRatio = the store's required pixel size.
const DEVICES = [
  { dir: 'android/phone', width: 360, height: 640, scale: 3 }, // 1080×1920
  { dir: 'ios/iphone-6.9', width: 440, height: 956, scale: 3 }, // 1320×2868
  { dir: 'ios/iphone-6.5', width: 428, height: 926, scale: 3 }, // 1284×2778
  { dir: 'ios/ipad-13', width: 1032, height: 1376, scale: 2 }, // 2064×2752
];

const SHOTS = join(store, 'screenshots');
const GRAPHICS = join(store, 'graphics');

/** Width, height and colour type straight from the IHDR; colour type 2 is RGB without alpha. */
function pngInfo(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

/** Writes `png`, insisting on the exact size and an opaque image. */
function save(path, png, width, height) {
  let buf = png;
  let info = pngInfo(buf);
  if (info.width !== width || info.height !== height) throw new Error(`${relative(repo, path)}: got ${info.width}×${info.height}, want ${width}×${height}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  if (info.colorType !== 2) {
    // Strip alpha with sips (macOS): a JPEG round trip at best quality, back to PNG.
    const jpg = `${path}.jpg`;
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '100', path, '--out', jpg], { stdio: 'ignore' });
    execFileSync('sips', ['-s', 'format', 'png', jpg, '--out', path], { stdio: 'ignore' });
    rmSync(jpg);
    buf = readFileSync(path);
    info = pngInfo(buf);
  }
  console.log(`  ${relative(repo, path)}  ${info.width}×${info.height}`);
}

async function shoot(chrome, device, name, prepare) {
  const page = await openPage(chrome.browser, device);
  try {
    await prepare(page);
    await sleep(600);
    save(join(SHOTS, device.dir, `${name}.png`), await page.screenshot(), device.width * device.scale, device.height * device.scale);
    if (page.errors.length) console.warn(`  ! ${device.dir}/${name}: page errors: ${page.errors.join(' | ')}`);
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------- graphics

const font = (file) => `data:font/woff2;base64,${readFileSync(join(repo, 'packages/web/src/assets/fonts', file)).toString('base64')}`;
const FONTS = `
  @font-face { font-family: 'Chakra Petch'; font-weight: 600; src: url(${font('chakra-petch-latin-600-normal.woff2')}) format('woff2'); }
  @font-face { font-family: 'Inter'; font-weight: 100 900; src: url(${font('inter-latin-wght-normal.woff2')}) format('woff2'); }`;
const brandSvg = (file) => readFileSync(join(repo, 'docs/brand', file), 'utf8');

async function renderHtml(chrome, html, width, height) {
  const page = await openPage(chrome.browser, { width, height, scale: 1, mobile: false });
  try {
    const { frameTree } = await page.send('Page.getFrameTree');
    await page.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
    await page.evaluate('document.fonts.ready.then(() => true)');
    await sleep(200);
    return await page.screenshot();
  } finally {
    await page.close();
  }
}

async function graphics(chrome) {
  console.log('graphics');
  // docs/brand/README.md: the mark is 1.5× the name's font size tall, 0.6× of it away. Violet mark
  // on the dark page background is the large-format version.
  const mark = brandSvg('cezar-mark-violet.svg').replace('<svg ', '<svg class="mark" ');
  const feature = `<!doctype html><html><head><meta charset="utf-8"><style>${FONTS}
    html, body { margin: 0; width: 1024px; height: 500px; background: #0E0C10; overflow: hidden; }
    body { display: grid; place-items: center; }
    .lockup { display: flex; align-items: center; gap: 58px; }
    .mark { height: 144px; width: auto; display: block; }
    .name { font: 600 96px/1 'Chakra Petch'; color: #FFFFFF; margin: 0; }
    .line { font: 400 30px/1.3 Inter; color: #A9A2AD; margin: 18px 0 0; }
  </style></head><body><div class="lockup">${mark}<div><p class="name">cezar</p><p class="line">Your coding agents, in your pocket.</p></div></div></body></html>`;
  save(join(GRAPHICS, 'feature-graphic.png'), await renderHtml(chrome, feature, 1024, 500), 1024, 500);

  // Play applies its own mask, so the icon is the brand tile edge to edge (as the iOS icon in
  // scripts/build-brand.mjs), mark at its tile proportions.
  const tile = brandSvg('cezar-icon-black.svg').replace(/\srx="[\d.]+"/, '').replace('<svg ', '<svg width="512" height="512" ');
  const icon = `<!doctype html><html><head><style>html, body { margin: 0; background: #000; } svg { display: block; }</style></head><body>${tile}</body></html>`;
  save(join(GRAPHICS, 'play-icon-512.png'), await renderHtml(chrome, icon, 512, 512), 512, 512);
}

// ---------------------------------------------------------------- connect screen

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serveDir(dir) {
  const server = createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const path = join(dir, name);
    if (!path.startsWith(dir) || !existsSync(path)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(path));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// The paired computer as native reports it (ConnectionPlugin): a relay server's url is the relay origin.
const RELAY = 'https://rome.cezar.run';
const PAIRED = { id: 'mac', label: 'MacBook Pro', url: RELAY, relay: true, push: true };

// A value as a JS literal inside an injected script: JSON, with the characters that could end a script escaped.
const literal = (value) => JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** A fake Capacitor `Connection` plugin, installed before connect.js runs. Unknown calls never settle. */
const fakeNative = (answers) => `
  window.Capacitor = { nativePromise: (plugin, method) => {
    const answers = ${literal(answers)};
    return method in answers ? Promise.resolve(answers[method]) : new Promise(() => {});
  } };`;

const heading = (text) => `document.querySelector('h1')?.textContent === ${literal(text)}`;
const fill = (values) => `(() => { for (const [name, value] of Object.entries(${literal(values)})) document.querySelector('input[name=' + name + ']').value = value; return true; })()`;

// Relay pairing (QR / typed code) is Android-only for now: iOS keeps the URL + password form
// until its relay client compiles (connect.js). Each platform shows what its app really does;
// --ios-pairing gives iOS the Android scenes once that changes.
const HOSTED = { id: 'work', label: 'Work', url: 'https://cezar.example.com', username: 'dev' };
const IOS_SCENES = [
  {
    name: '04-connect',
    answers: { launch: { servers: [] } },
    async act(page) {
      await page.waitFor(heading('Connect to cezar'));
      await page.evaluate(fill({ url: HOSTED.url }));
    },
    ready: heading('Connect to cezar'),
  },
  {
    name: '05-sign-in',
    answers: { launch: { screen: 'ask-credentials', serverId: HOSTED.id, servers: [HOSTED] } },
    async act(page) {
      await page.waitFor(heading('Sign in'));
      await page.evaluate(fill({ password: 'correct horse battery' }));
    },
    ready: heading('Sign in'),
  },
  {
    name: '06-servers',
    answers: { launch: { servers: [HOSTED] } },
    ready: heading('Servers'),
  },
];

const ANDROID_SCENES = [
  {
    name: '04-connect',
    answers: { launch: { servers: [], pairing: true, relayDefault: RELAY } },
    ready: heading('Connect to cezar'),
  },
  {
    name: '05-pair-code',
    answers: { launch: { servers: [], pairing: true, relayDefault: RELAY } },
    async act(page) {
      await page.waitFor(heading('Connect to cezar'));
      await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Enter code').click());
      await page.waitFor(heading('Enter code'));
      await page.evaluate(fill({ code: 'K7QM-4XHT-9PWD' }));
    },
    ready: heading('Enter code'),
  },
  {
    name: '06-servers',
    answers: { launch: { servers: [PAIRED], pairing: true, relayDefault: RELAY, lock: { enabled: true, available: true } } },
    ready: heading('Servers'),
  },
];

async function connectScreens(chrome) {
  const dir = realpathSync(args.connect);
  for (const file of ['index.html', 'connect.js', 'screens.js', 'connect.css']) if (!existsSync(join(dir, file))) throw new Error(`${dir}: missing ${file}`);
  console.log(`connect screen (${dir})`);
  const server = await serveDir(dir);
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  try {
    for (const device of DEVICES) {
      const folder = join(SHOTS, device.dir);
      if (existsSync(folder)) for (const old of readdirSync(folder)) if (/^0[4-6]-.*\.png$/.test(old)) rmSync(join(folder, old));
      const scenes = device.dir.startsWith('ios/') && !args['ios-pairing'] ? IOS_SCENES : ANDROID_SCENES;
      for (const scene of scenes)
        await shoot(chrome, device, scene.name, async (page) => {
          await page.addInitScript(fakeNative(scene.answers));
          await page.goto(url);
          if (scene.act) await scene.act(page);
          await page.waitFor(scene.ready);
        });
    }
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------- cockpit

const DIST = join(repo, 'packages/cezar/dist/index.js');
const WEB = join(repo, 'packages/cezar/web/dist/index.html');

function ensureBuilt() {
  if (existsSync(DIST) && existsSync(WEB)) return;
  console.log('building cezar (npm ci, build:server, build:web)…');
  const run = (...a) => execFileSync('npm', a, { cwd: repo, stdio: 'inherit', env: cleanEnv() });
  if (!existsSync(join(repo, 'node_modules'))) run('ci', '--no-audit', '--no-fund');
  run('run', 'build:server');
  run('run', 'build:web');
}

/** The caller's environment minus every inherited CEZ_* (a task shell leaks its own). */
function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CEZ_')));
  return { ...env, ...extra };
}

/** A temp dir outside any git repo (TMPDIR may point inside one). */
function scratch() {
  let base = realpathSync(tmpdir());
  try {
    execFileSync('git', ['-C', base, 'rev-parse'], { stdio: 'ignore' });
    base = '/private/tmp';
  } catch {
    // not in a repo, good
  }
  return mkdtempSync(join(base, 'cezar-store-'));
}

function demoProject(root) {
  const project = join(root, 'storefront');
  const files = {
    'README.md': '# storefront\n\nThe web shop: catalog, cart and checkout.\n',
    'package.json': '{\n  "name": "storefront",\n  "version": "1.4.0",\n  "type": "module"\n}\n',
    'src/cart.js': 'export function total(items) {\n  return items.reduce((sum, item) => sum + item.price * item.qty, 0);\n}\n',
    'src/checkout.js': "import { total } from './cart.js';\n\nexport function summary(cart) {\n  return { items: cart.length, total: total(cart) };\n}\n",
    'src/shipping.js': 'export const shipping = (weightKg) => (weightKg > 20 ? 0 : 4.9 + weightKg * 0.5);\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(project, name)), { recursive: true });
    writeFileSync(join(project, name), text);
  }
  const git = (...a) => execFileSync('git', a, { cwd: project, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=storefront', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'Catalog, cart and checkout');
  return project;
}

class Cezar {
  constructor(root, project) {
    this.root = root;
    this.project = project;
    this.home = join(root, 'home');
    mkdirSync(this.home, { recursive: true });
    writeFileSync(join(this.home, '.gitconfig'), '[user]\n\tname = storefront\n\temail = dev@example.com\n');
  }

  async start(pace) {
    const port = Number(args.port) || (await freePort());
    this.base = `http://127.0.0.1:${port}`;
    // Four tasks at once (three parked, one live); the default cap of 2 would queue the live one.
    mkdirSync(join(this.root, 'cezar-home'), { recursive: true });
    writeFileSync(join(this.root, 'cezar-home/config.json'), JSON.stringify({ resources: { maxParallel: 6 } }));
    const env = cleanEnv({
      HOME: this.home, // no global skills, gh login or git identity from the real user
      CEZ_HOME: join(this.root, 'cezar-home'),
      CEZ_DRY_RUN: '1',
      CEZ_MOCK_PACE: String(pace),
      CEZ_NO_BANNER: '1',
      CEZ_SKILLS_AUTO_UPDATE: '0',
      CEZ_TELEMETRY: '0',
      CEZ_UPDATE_CHANNEL: 'development',
      DO_NOT_TRACK: '1',
      TMPDIR: this.root,
    });
    // Its own process group, so stop() takes the mock agents down with it.
    this.child = spawn(process.execPath, [DIST, '--port', String(port), '--no-open', '--repo', this.project], { cwd: this.project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.log = '';
    this.child.stdout.on('data', (d) => (this.log += d));
    this.child.stderr.on('data', (d) => (this.log += d));
    console.log(`  cezar pid ${this.child.pid} on ${this.base} (mock pace ${pace})`);
    for (let i = 0; i < 120; i++) {
      if (this.child.exitCode !== null) throw new Error(`cezar exited:\n${this.log}`);
      if (await fetch(`${this.base}/api/v1/health`).then((r) => r.ok, () => false)) return;
      await sleep(250);
    }
    throw new Error(`cezar did not become healthy:\n${this.log}`);
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    const exited = new Promise((resolve) => this.child.once('exit', resolve));
    try {
      process.kill(-this.child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    await Promise.race([exited, sleep(8000)]);
    try {
      process.kill(-this.child.pid, 'SIGKILL');
    } catch {
      // exited
    }
  }

  async api(path, body, method = body ? 'POST' : 'GET') {
    const res = await fetch(`${this.base}/api/v1${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  }

  task(task) {
    return this.api('/runs', { workflow: 'quick-task', task, runner: 'claude' });
  }

  async waitRun(id, statuses, timeout = 60000) {
    const until = Date.now() + timeout;
    for (;;) {
      const run = await this.api(`/runs/${id}`);
      if (statuses.includes(run.status)) return run;
      if (Date.now() > until) throw new Error(`run ${id} stuck at ${run.status}`);
      await sleep(300);
    }
  }

  /** The mock agent drops a demo page into every run's artifacts; no real agent would. */
  dropDemoArtifacts() {
    const dir = join(this.project, '.ai/cezar/artifacts');
    if (!existsSync(dir)) return;
    for (const run of readdirSync(dir)) rmSync(join(dir, run, 'demo.html'), { force: true });
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const textOf = () => document.body.innerText;
// CEZ_MOCK_PACE: the mock's pauses × 30, so the `git status` step stays on screen about 9 s.
const PACE = 30;

async function cockpit(chrome) {
  ensureBuilt();
  console.log('cockpit (CEZ_DRY_RUN=1)');
  const root = scratch();
  const project = demoProject(root);
  const cezar = new Cezar(root, project);
  const sweep = setInterval(() => cezar.dropDemoArtifacts(), 200);
  try {
    // One server, mock paced so a turn takes about a minute: slow enough to photograph a task
    // mid-turn, and a restart would settle the parked sessions the list should show as "needs you".
    await cezar.start(PACE);
    const projectUrl = `${cezar.base}/p/storefront`;
    // A visited, set-up workspace: no first-run setup chip. A visit stamp this fresh also stops the
    // cockpit rewriting `onboarding` (and so dropping the flag) when a page loads.
    const now = new Date().toISOString();
    await cezar.api('/workspace/ui-state', { onboarding: { firstVisitAt: now, lastVisitAt: now, setupDismissed: true } }, 'PUT');

    const finished = [];
    for (const task of ['Add a discount code field to the checkout', 'Fix the cart total rounding for prices with three decimals', 'Write tests for the shipping cost calculator'])
      finished.push(await cezar.task(task));
    const manager = await cezar.api('/workspace/managers', {
      name: 'Shop lead',
      instructions: 'Keep the storefront moving: watch tasks and pull requests, and tell me what needs me.',
      projects: 'all',
      cronMinutes: 0,
    });
    for (const run of finished) await cezar.waitRun(run.id, ['waiting'], 240000);
    console.log('  three tasks waiting');
    // The first one is approved and lands in review; the manager is asked about the rest.
    await cezar.api(`/runs/${finished[0].id}/messages`, { text: 'Looks good, ship it. mock:done' });
    await cezar.api(`/workspace/managers/${manager.id}/messages`, { text: 'What needs me on the storefront right now?' });
    await cezar.waitRun(finished[0].id, ['review', 'done'], 120000);
    for (let i = 0; ; i++) {
      const [messages, { status }] = await Promise.all([cezar.api(`/workspace/managers/${manager.id}/messages`), cezar.api(`/workspace/managers/${manager.id}`)]);
      if (status === 'idle' && JSON.stringify(messages).includes('where things stand')) break;
      if (i > 600) throw new Error('the manager never answered');
      await sleep(200);
    }
    console.log('  manager answered');

    // The live view: every device open first, then all photographed while `git status` runs
    // (the mock's next step is a placeholder screenshot no real agent would show).
    const live = await cezar.task('Show the order history on the account page');
    // One browser per device: four live cockpits in one browser exceed its six connections per
    // host, and a starved event stream never shows the call.
    const pages = [];
    const browsers = [];
    try {
      for (const device of DEVICES) {
        const own = await launchChrome();
        browsers.push(own);
        const page = await openPage(own.browser, device);
        pages.push([device, page]);
        await page.goto(`${projectUrl}/tasks/${live.id}`);
      }
      // The run's own event log says when the mock calls `git status`; ~15 s later it moves on.
      const events = join(project, `.ai/cezar/runs/${live.id}.ndjson`);
      const log = () => (existsSync(events) ? readFileSync(events, 'utf8') : '');
      for (let i = 0; !log().includes('"tool-call","id":"toolu_mock_1"'); i++) {
        if (i > 600) throw new Error(`the live task never reached git status (${(await cezar.api(`/runs/${live.id}`)).status})`);
        await sleep(200);
      }
      // Each page must show the call itself, not a loading skeleton.
      for (const [device, page] of pages) {
        await page.front();
        await page.waitFor(() => document.body.innerText.includes('git status'), 8000).catch(async (error) => {
          throw new Error(`${device.dir}: ${error.message} ${(await page.evaluate(textOf)).slice(0, 600)}`);
        });
      }
      await sleep(500);
      const shots = [];
      for (const [device, page] of pages) {
        await page.front();
        shots.push([device, await page.screenshot()]);
      }
      if (log().includes('toolu_mock_shot_1')) throw new Error('missed the live window: the mock moved past git status');
      for (const [device, png] of shots) save(join(SHOTS, device.dir, '02-task-live.png'), png, device.width * device.scale, device.height * device.scale);
    } finally {
      for (const own of browsers) await own.close();
    }

    for (const device of DEVICES)
      await shoot(chrome, device, '01-tasks', async (page) => {
        await page.goto(`${projectUrl}/`);
        await page.waitFor(() => document.body.innerText.includes('Show the order history') && !document.querySelector('[aria-label="Hide setup"]'));
      });
    if ((await cezar.api(`/runs/${live.id}`)).status !== 'running') console.warn('  ! the live task finished before 01-tasks; raise PACE');

    for (const device of DEVICES)
      await shoot(chrome, device, '03-manager', async (page) => {
        await page.goto(`${cezar.base}/manager/${manager.id}`);
        await page.waitFor(() => document.body.innerText.includes('Here is where things stand'));
      });
  } catch (error) {
    if (cezar.log) console.error(cezar.log.split('\n').slice(-30).join('\n'));
    throw error;
  } finally {
    clearInterval(sweep);
    await cezar.stop();
    if (args.keep) console.log(`  kept ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- main

const chrome = await launchChrome();
try {
  if (only.has('graphics')) await graphics(chrome);
  if (only.has('connect')) await connectScreens(chrome);
  if (only.has('cockpit')) await cockpit(chrome);
} finally {
  await chrome.close();
}
