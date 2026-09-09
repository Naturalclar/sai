// サーバのポートの決め方。1 か所に置いて、サーバ（server/main.ts の起動）と Vite（web/vite.config.ts の
// /api の proxy 先）が同じ規則を見る。片方だけ 8787 を直書きしていると、SAI_PORT を変えた人の
// `pnpm dev` が全部 500 になる（#146）。

/** 何も指定が無いときのポート */
export const DEFAULT_PORT = 8787

/**
 * ポートの文字列を数にする。1〜65535 の整数だけ通し、それ以外（空・非数・範囲外）は null。
 * `--port abc` も `SAI_PORT=abc` も同じ扱い
 */
export function parsePort(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null
  const port = Number.parseInt(value, 10)
  return port >= 1 && port <= 65535 ? port : null
}

/**
 * 環境変数からポートを決める。**Vite は起動引数（`--port`）を知らない**ので、`SAI_PORT` だけ見る。
 * 値がおかしければ既定に落として `invalid` にその値を入れる（dev サーバを止めるほどではないが、黙って
 * 8787 に流すと原因が分からないので呼び出し側が warn する）
 */
export function portFromEnv(value: string | undefined): { port: number; invalid?: string } {
  if (value === undefined || value === '') return { port: DEFAULT_PORT }
  const port = parsePort(value)
  return port === null ? { port: DEFAULT_PORT, invalid: value } : { port }
}
