import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { portFromEnv } from '../shared/port.ts'

// ヘッダーの GitHub リンク先。URL は package.json の repository を正本にして、画面には define で渡す
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { repository?: string }

// `pnpm dev` は API を server/ に流す。流す先は `SAI_PORT`（サーバと同じ規則。shared/port.ts）。
// **`pnpm start --port` は見えない**（Vite はサーバの起動引数を知らない）ので、そのときは SAI_PORT も揃える
const { port: apiPort, invalid } = portFromEnv(process.env.SAI_PORT)
if (invalid !== undefined) {
  console.warn(`SAI_PORT=${invalid} は 1〜65535 の整数ではないので、/api の proxy 先は ${apiPort} にします`)
}

export default defineConfig({
  plugins: [react()],
  define: { 'import.meta.env.REPO_URL': JSON.stringify(pkg.repository ?? '') },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
    fs: { allow: ['..'] }, // ../shared を読む
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
