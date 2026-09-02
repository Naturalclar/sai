import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// ヘッダーの GitHub リンク先。URL は package.json の repository を正本にして、画面には define で渡す
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { repository?: string }

// `pnpm dev` は API を server/ に流す。server 側は 127.0.0.1:8787 で待つ想定
export default defineConfig({
  plugins: [react()],
  define: { 'import.meta.env.REPO_URL': JSON.stringify(pkg.repository ?? '') },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:8787' },
    fs: { allow: ['..'] }, // ../shared を読む
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
