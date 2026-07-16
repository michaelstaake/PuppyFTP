import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const buildDate = new Date().toISOString().slice(0, 10)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __BUILD_DATE__: JSON.stringify(buildDate),
    },
    build: {
      rollupOptions: {
        external: ['puppyftp-rdp-host'],
      },
    },
  },
  // Sandboxed preload cannot load ESM `import` — bundle as a single CJS file.
  // Do not externalize deps: sandbox only has a limited polyfilled require().
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: 'cjs'
        }
      }
    }
  },
  renderer: {
    base: './',
    // Project-root public/ (not src/renderer/public) so logo-icon.png is served in dev + build
    publicDir: resolve('public'),
    resolve: {
      alias: {
        '@': resolve('src/renderer'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})
