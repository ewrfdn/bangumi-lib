import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig(({ mode }) => {
  // Frontend configuration belongs to web/.env*; backend .env is never read.
  const env = loadEnv(mode, webRoot, '')
  const target = process.env.API_TARGET || env.API_TARGET || 'http://127.0.0.1:8088'
  const proxy = {
    '/api': {
      target,
      changeOrigin: false,
      proxyTimeout: 300_000,
      timeout: 300_000,
    },
    // Bangumi covers are served by the backend outside /api. Keep this narrower
    // than /assets so the built app's own /assets/index-*.js files are untouched.
    '/assets/bangumi': {
      target,
      changeOrigin: false,
      proxyTimeout: 300_000,
      timeout: 300_000,
    },
  }
  return {
    root: webRoot,
    envDir: webRoot,
    plugins: [vue()],
    server: { host: '0.0.0.0', port: Number(process.env.WEB_PORT || env.WEB_PORT || 6001), strictPort: true, proxy, watch: { ignored: ['**/.*.tmpdir/**', '**/*.tmp'] } },
    preview: { host: '0.0.0.0', port: Number(process.env.WEB_PORT || env.WEB_PORT || 6001), strictPort: true, proxy },
    build: { outDir: 'dist', chunkSizeWarningLimit: 1200 },
  }
})
