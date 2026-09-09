import { useCallback, useEffect, useState } from 'react'
import { api, type UsageResponse } from './api'

/**
 * 各エージェントの使用量（#216）。**3 秒のポーリングには乗せない**（サーバがファイルを漁るので）。
 * 取るのは、開いたとき・タブに戻ってきたとき・パネルを開いたとき（reload）だけ
 * （`useSkills` / `useCommandPalette` と同じ流儀）。サーバ側も 30 秒キャッシュしている。
 *
 * 取れなかった（Codex を使っていない、Claude が上限に当たっていない）は空の `{}` で返るので、
 * 「まだ取っていない」（null）と区別できる。失敗は黙って捨てる（ヘッダの飾りなので、画面に出すほどのことではない）
 */
export function useUsage() {
  // at は取ってきた時刻。「あと 42 分」の基準に使う（描画中に Date.now() を呼ばない）
  const [state, setState] = useState<{ usage: UsageResponse | null; at: number }>({ usage: null, at: 0 })
  // これを進めると取り直す（取得そのものは effect の中に 1 つだけ置く）
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let alive = true
    void api.usage().then(
      (next) => alive && setState({ usage: next, at: Date.now() }),
      () => {
        // 取れなくても画面は動く（何も出さないだけ）
      },
    )
    return () => {
      alive = false
    }
    // nonce は「取り直す」の合図なので本文では読まない（hooks.ts の usePolling の deps と同じ考え方）
    // eslint-disable-next-line react/exhaustive-effect-dependencies
  }, [nonce])

  // タブに戻ってきたら取り直す（隠れている間に枠が進んでいる）
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [reload])

  return { usage: state.usage, at: state.at, reload }
}
