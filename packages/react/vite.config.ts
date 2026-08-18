import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
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
  build: {
    outDir: resolve(packageDir, 'dist'),
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        index: resolve(packageDir, 'src/index.ts'),
        tasks: resolve(packageDir, 'src/tasks.ts'),
        session: resolve(packageDir, 'src/session.ts'),
        styles: resolve(packageDir, 'src/styles/index.css'),
      },
      external: isReactPackageExternal,
      output: {
        entryFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
})
