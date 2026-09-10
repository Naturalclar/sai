import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type SessionDiffSummaryResponse } from './api'

const NONE: ReadonlyMap<string, SessionDiffSummaryResponse> = new Map()

/**
 * フィードのバブルに出す差分のボタンの、行数と PR 番号（#280）。`useDiffSummary` の複数セッション版。
 *
 * 取りに行くのは `stamps`（`feedDiff.ts` の `prStamps()`。PR に触れたセッション → 最後のターン完了の ts）に
 * 載っているものだけで、**取り直すのはそのセッションの目印が変わったときだけ**。3 秒のポーリングには載せない
 * （#171 / #211。セッションの数だけ git と `gh` が走る）。取り直している間は前の値を出したまま（ボタンが点滅しない）。
 * 取れなければ載せないだけ（ボタンが出ない）で、同じ目印では取り直さない
 */
export function useDiffSummaries(stamps: ReadonlyMap<string, string>): ReadonlyMap<string, SessionDiffSummaryResponse> {
  const [loaded, setLoaded] = useState(NONE)
  // 投げた (id → 目印)。フィードの行が増えるたびに effect が走るが、目印が同じなら投げ直さない
  const asked = useRef(new Map<string, string>())

  useEffect(() => {
    for (const [id, stamp] of stamps) {
      if (asked.current.get(id) === stamp) continue
      asked.current.set(id, stamp)
      void api.diffSummary(id).then(
        (data) => setLoaded((prev) => new Map(prev).set(id, data)),
        // git が読めない（cwd が消えた、リポジトリでない）。ボタンを出さないだけ
        () => {},
      )
    }
  }, [stamps])

  // 窓やリポジトリの切り替えで行から消えたセッションの分は出さない
  return useMemo(() => {
    const out = new Map<string, SessionDiffSummaryResponse>()
    for (const id of stamps.keys()) {
      const data = loaded.get(id)
      if (data) out.set(id, data)
    }
    return out
  }, [loaded, stamps])
}
