// 配っている web/dist/ がソース（web/src, web/index.html, shared/）より古いかの判定。
// git pull したあと pnpm build を忘れると、記録もサーバも新しいのに画面だけ古い、という取り残しが起きる
// （#69）。サーバは X-SAI-Build で「いまのビルド」を伝えているが、それが古いかは誰も見ていなかった。
// git は叩かない（依存ゼロ・node:http 直書きの方針）。ファイルの mtime だけで判定する。
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** distDir（web/dist）から見た、ビルドの元になるもの */
export function defaultSourceDirs(distDir: string): string[] {
  const web = resolve(distDir, '..')
  return [join(web, 'src'), join(web, 'index.html'), resolve(web, '..', 'shared')]
}

/** 走査で飛ばすもの。テストはビルドに入らない */
function skip(name: string): boolean {
  return name === 'node_modules' || name === 'dist' || name.startsWith('.') || name.endsWith('.test.ts')
}

/** paths（ファイルでもディレクトリでも）の下で一番新しい mtime。何も無ければ null */
export async function newestMtime(paths: string[]): Promise<number | null> {
  let newest: number | null = null
  const visit = async (path: string): Promise<void> => {
    let st
    try {
      st = await stat(path)
    } catch {
      return // 無いものは飛ばす
    }
    if (st.isDirectory()) {
      let entries
      try {
        entries = await readdir(path, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (skip(entry.name)) continue
        await visit(join(path, entry.name))
      }
      return
    }
    if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs
  }
  for (const path of paths) await visit(path)
  return newest
}

/**
 * 「ビルドが古いか」を答える。走査はポーリングごとにはせず ttlMs に1回。
 * dist が無い（未ビルド）ときとソースが見つからないときは「古い」とは言わない（別の話）
 */
export class BuildFreshness {
  readonly distDir: string
  readonly sourceDirs: string[]
  readonly ttlMs: number
  private cache: { at: number; stale: boolean } | null = null

  constructor(distDir: string, sourceDirs: string[] = defaultSourceDirs(distDir), ttlMs = 30_000) {
    this.distDir = distDir
    this.sourceDirs = sourceDirs
    this.ttlMs = ttlMs
  }

  async stale(now = Date.now()): Promise<boolean> {
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.stale
    const stale = await this.compute()
    this.cache = { at: now, stale }
    return stale
  }

  private async compute(): Promise<boolean> {
    let dist: number
    try {
      dist = (await stat(join(this.distDir, 'index.html'))).mtimeMs
    } catch {
      return false
    }
    const source = await newestMtime(this.sourceDirs)
    return source !== null && source > dist
  }
}
