import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vite'

const packageDir = dirname(fileURLToPath(import.meta.url))

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
      external: ['react', 'react-dom'],
      output: {
        entryFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
})
