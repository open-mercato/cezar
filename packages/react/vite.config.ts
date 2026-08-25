import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const packageDir = dirname(fileURLToPath(import.meta.url))

export const isReactPeerExternal = (id: string) =>
  id === 'react'
  || id.startsWith('react/')
  || id === 'react-dom'
  || id.startsWith('react-dom/')

const runtimeDependencies = [
  '@open-mercato/cezar-api-client',
  '@tanstack/react-query',
]

export const isReactPackageExternal = (id: string) =>
  isReactPeerExternal(id)
  || runtimeDependencies.some((dependency) => id === dependency || id.startsWith(`${dependency}/`))

export default defineConfig({
  base: './',
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      '#cezar-web-cockpit': resolve(packageDir, '../web/src/cockpit-implementation.tsx'),
      '@': resolve(packageDir, '../web/src'),
      '@open-mercato/cezar-react': resolve(packageDir, 'src/index.ts'),
    },
  },
  build: {
    outDir: resolve(packageDir, 'dist'),
    emptyOutDir: true,
    rolldownOptions: {
      preserveEntrySignatures: 'exports-only',
      input: {
        index: resolve(packageDir, 'src/index.ts'),
        cockpit: resolve(packageDir, 'src/cockpit.tsx'),
        tasks: resolve(packageDir, 'src/tasks.ts'),
        session: resolve(packageDir, 'src/session.ts'),
        styles: resolve(packageDir, 'src/styles/index.css'),
      },
      external: isReactPackageExternal,
      output: {
        entryFileNames: '[name].js',
        assetFileNames: (asset) => asset.name === 'styles.css'
          ? '[name][extname]'
          : 'assets/[name][extname]',
      },
    },
  },
})
