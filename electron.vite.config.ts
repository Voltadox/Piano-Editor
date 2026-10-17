import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // the vocal separator runs as its own utility process
        input: { index: resolve('src/main/index.ts'), separator: resolve('src/main/separator.ts') }
      }
    }
  },
  preload: {},
  renderer: {
    plugins: [react()],
    worker: { format: 'es' }
  }
})
