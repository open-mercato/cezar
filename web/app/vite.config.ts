import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const appDir = dirname(fileURLToPath(import.meta.url))
const webDir = resolve(appDir, '..')

// The cockpit server (src/server/server.ts) owns /api and serves the built app from web/dist.
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

export default defineConfig({
  root: appDir,
  base: '/',
  // Tailwind v4 is CSS-first: the whole theme lives in src/styles/index.css, there is no tailwind.config.js.
  plugins: [react(), tailwindcss()],
  // `@/…` → web/app/src — the alias shadcn/ui components import `cn` through. Mirrored in tsconfig.json `paths`.
  resolve: {
    alias: { '@': resolve(appDir, 'src') },
  },
  build: {
    // The built cockpit lives in web/dist (the legacy UI files were removed in R7).
    outDir: resolve(webDir, 'dist'),
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
      '/api': { target: API_TARGET, changeOrigin: true, ws: true },
    },
  },
})
