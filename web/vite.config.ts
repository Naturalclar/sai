import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `pnpm dev` は API を server/ に流す。server 側は 127.0.0.1:8787 で待つ想定
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:8787' },
    fs: { allow: ['..'] }, // ../shared を読む
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
