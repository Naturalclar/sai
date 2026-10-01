// rev が同じなら本文を受け取らない（#592）。一覧・詳細・フィードは 3 秒ごとに取り直すが、変わっていないことの方が多い。
// 前に受け取った本文を URL ごとに覚えておき、次は `If-None-Match` を付けて聞く。サーバが 304 を返したら覚えた本文をそのまま使う
// （同じオブジェクトなので `usePolling` は rev が同じと見て描き直さない）。
// ブラウザのキャッシュには任せない（`Cache-Control: no-store` のまま。履歴の本文をディスクに残さない）

/** 覚えておく URL の数。開いている画面（一覧・詳細・2 枚目・フィード）とその前後ぶん */
export const REV_CACHE_MAX = 8

export class RevCache {
  private readonly max: number
  /** 挿入順 = 古い順（使ったら入れ直す） */
  private readonly entries = new Map<string, { etag: string; data: unknown }>()

  constructor(max = REV_CACHE_MAX) {
    this.max = max
  }

  get(url: string): { etag: string; data: unknown } | undefined {
    const hit = this.entries.get(url)
    if (!hit) return undefined
    this.entries.delete(url)
    this.entries.set(url, hit)
    return hit
  }

  set(url: string, etag: string, data: unknown): void {
    this.entries.delete(url)
    this.entries.set(url, { etag, data })
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!)
  }
}

/** `fetch` の要るところだけ（テストは偽物を渡す） */
type Fetch = (url: string, init: { cache: 'no-store'; headers?: Record<string, string> }) => Promise<Response>

/**
 * 覚えた本文があれば `If-None-Match` を付けて取る。304 なら覚えた本文、200 なら新しい本文を覚えて返す。
 * `ok` でない応答は呼び出し側に返す（失敗の読み方は `api.ts` の `failure()` の 1 つ）
 */
export async function fetchByRev(cache: RevCache, url: string, doFetch: Fetch): Promise<{ res: Response; data?: unknown }> {
  const memo = cache.get(url)
  const res = await doFetch(url, { cache: 'no-store', ...(memo ? { headers: { 'If-None-Match': memo.etag } } : {}) })
  if (res.status === 304 && memo) return { res, data: memo.data }
  if (!res.ok) return { res }
  const data: unknown = await res.json()
  const etag = res.headers.get('etag')
  if (etag) cache.set(url, etag, data)
  return { res, data }
}
