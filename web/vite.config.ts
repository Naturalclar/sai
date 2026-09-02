import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `pnpm dev` は API を serve.py に流す。serve.py 側は 127.0.0.1:8787 で待つ想定
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
