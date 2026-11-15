import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const appDir = dirname(fileURLToPath(import.meta.url))
const packagesDir = resolve(appDir, '..')

// The cockpit server (packages/cezar/src/server/server.ts) owns /api and serves the built app.
// `npm run dev` (scripts/dev.mjs) picks a free port and pins both processes to it via
// CEZ_API_PORT, so a stray cockpit already sitting on 4321 (another repo, an older install)
// can never end up behind the proxy. Standalone `npm run dev:web` keeps the 4321 default.
const API_TARGET = `http://127.0.0.1:${process.env.CEZ_API_PORT ?? 4321}`

// React DOM is large enough to push the otherwise route-split entry chunk over Vite's 500 kB
// warning threshold. Keep the tightly coupled React runtime in one stable, cacheable chunk
// rather than silencing the warning: future growth in either the app or vendor chunk stays
// visible. Module ids from Vite/Rolldown use forward slashes on every platform.
export const reactRuntimeChunk = {
  name: 'react-runtime',
  test: /node_modules\/(?:react(?:-dom)?|scheduler)\//,
}

// Artifact pages: the server builds the page's CSP `img-src` from the Host it saw (#1920), so this
// route keeps the browser's own Host (no `changeOrigin`) and a relative <img> matches. Matched
// before `/api`; GET-only, so the origin guard's Host check (loopback) is all that applies.
export const artifactsProxyKey = '^/api/v1/(?:p/[^/]+/)?runs/[^/]+/artifacts/'

/** `<version>+<commit>.<build time>`: unique per build, so a rebuild of the same version and
 *  commit in place still reads as a different build. */
function webBuildId(): string {
  const { version } = JSON.parse(readFileSync(resolve(packagesDir, 'cezar/package.json'), 'utf8')) as { version: string }
  let commit = 'nogit'
  try {
    commit = execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    // A tarball build outside a checkout: the time alone keeps it unique.
  }
  return `${version}+${commit}.${Date.now().toString(36)}`
}

/** Stamps the build's identity into the bundle (`__CEZ_WEB_BUILD__`) and into index.html, where
 *  the server reads it at boot (src/server/build-identity.ts). Build-only: the dev server and
 *  vitest never define it, so neither can raise the stale-build banner. */
export function buildIdentity(id: () => string = webBuildId): Plugin {
  let stamp = ''
  return {
    name: 'cezar-build-identity',
    apply: 'build',
    config() {
      stamp = id()
      return { define: { __CEZ_WEB_BUILD__: JSON.stringify(stamp) } }
    },
    transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'cezar-build', content: stamp }, injectTo: 'head' }],
  }
}

export default defineConfig({
  root: appDir,
  base: '/',
  // Tailwind v4 is CSS-first: the whole theme lives in src/styles/index.css, there is no tailwind.config.js.
  plugins: [react(), tailwindcss(), buildIdentity()],
  // `@/…` → packages/web/src — the alias shadcn/ui components import `cn` through. Mirrored in
  // tsconfig.json `paths`.
  //
  // The api-client resolves to its SOURCE, not to its published `dist`. The package builds
  // (for Node consumers and for npm) but nothing in the web toolchain should have to wait for
  // that build: aliasing to source keeps `npm run dev` a single step and gives HMR when the
  // contract changes. Vite maps the package's internal `./x.ts` specifiers directly. Mirrored
  // in tsconfig.json `paths`.
  resolve: {
    alias: {
      '@': resolve(appDir, 'src'),
      '@open-mercato/cezar-api-client': resolve(packagesDir, 'api-client/src/index.ts'),
    },
  },
  build: {
    // Built INTO the server package, because the CLI ships and serves it: `resolveWebDir()`
    // looks for `<pkg>/web/dist` next to its own `dist/`, and `files` puts it in the tarball.
    // A cross-package output is the honest expression of that coupling — the cockpit bundle is
    // an artifact of the service, not a separately shipped thing.
    outDir: resolve(packagesDir, 'cezar/web/dist'),
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [reactRuntimeChunk],
        },
      },
    },
  },
  server: {
    proxy: {
      // `ws: true` — /api/ws (the subscription socket) upgrades through the same proxy.
      [artifactsProxyKey]: { target: API_TARGET },
      '/api': { target: API_TARGET, changeOrigin: true, ws: true },
    },
  },
})
