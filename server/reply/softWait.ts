// 走査（`ps` / `lsof` / `tmux`）を要求の中で待ちすぎない（#495）。
//
// 一覧（/api/sessions）は 3 秒ごとに叩かれる一番よく通る道で、端末の走査を子プロセスで待っていた。負荷が無ければ
// 初回でも 1 秒だが、Mac が重いとき（一言を作る Ollama、ビルド、動画）は `ps` 1 本が 2 秒、`lsof` が 1 pid で 2 秒になり、
// 初回が 38 秒、`days=30` で 69 秒になった。走査の結果は「いま端末で開いているか」「ダイアログが出ているか」で、
// 3 秒古くても困らないので、要求は短い締切だけ待ち、間に合わなければ**前回の結果**で返す。走査そのものは止めず
// 裏で続くので（各走査は同時に 1 本に絞ってある）、次のポーリングが新しい結果を拾う。
// 結果が変わったら画面が描き直すように、呼び出し側は結果を rev に混ぜる（`terminalKey()`、`approvalMapKey()`、`settledKey()`）

/** 要求の中で走査を待つ上限。負荷の無いときの初回の走査（並列で 0.3〜0.8 秒）が収まり、重いときは前回の結果で返す */
export const SCAN_WAIT_MS = 700

/**
 * `work` が `waitMs` までに終わればその値、終わらなければ `fallback()`。`work` は捨てずに走り続ける
 * （終われば呼び出し側のキャッシュに入り、次の要求で読める）。締切の前に失敗したらそのまま投げ、
 * 締切のあとの失敗は誰も待っていないので捨てる
 */
export function softWait<T>(work: Promise<T>, fallback: () => T, waitMs = SCAN_WAIT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve(fallback())
    }, waitMs)
    work.then(
      (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
