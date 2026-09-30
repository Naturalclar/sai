// 枠の軽い版が読めなかったときの見分け（#589）。`<img>` の onError からは状態が見えないので、同じ URL に HEAD を投げて見る。
// 503 + `X-SAI-Thumb: unavailable` は「元はあるが軽い版を作れない（sips が無い・失敗・締切）」で、押すまで元を読まない印にする。
// 200 は「さっきは間に合わなかったが今は出せる」（締切の直後に置き場に出来た など）なので 1 回だけ読み直す（#593 のレビュー）。
// それ以外（404 / 403 / 415 など）は今までどおり「表示できません」
export type ThumbFailure = { kind: 'heavy'; bytes: number } | { kind: 'retry' } | { kind: 'broken' }

export function thumbFailure(status: number, headers: Pick<Headers, 'get'>): ThumbFailure {
  if (status === 200) return { kind: 'retry' }
  if (status !== 503 || headers.get('x-sai-thumb') !== 'unavailable') return { kind: 'broken' }
  const bytes = Number(headers.get('x-sai-image-bytes'))
  return { kind: 'heavy', bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0 }
}

/** HEAD で確かめる。投げられなければ「表示できません」 */
export async function probeThumb(url: string): Promise<ThumbFailure> {
  try {
    const res = await fetch(url, { method: 'HEAD' })
    return thumbFailure(res.status, res.headers)
  } catch {
    return { kind: 'broken' }
  }
}
