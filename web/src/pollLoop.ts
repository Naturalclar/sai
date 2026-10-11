/**
 * 「返ってから次を張る」ポーリングのループ（#765。経緯は docs/history/web.md）。
 *
 * `setInterval` だと前の要求が返る前に次を投げるので、サーバが間隔より遅れると未返答の要求が積み上がり、さらに遅れる循環に入る。
 * ここでは `run` が終わってから `intervalMs()` 後に次を張るので、走っている要求は同時に 1 本までになる。
 *
 * - `kick()`: いま 1 回（走っていれば、終わった直後にもう 1 回）。タブに戻ったときの「待たずに 1 回」
 * - `rearm()`: 次までの間隔を取り直す（表と裏で間隔が違う）。走っている間は、終わったときに取り直すので何もしない
 * - `stop()`: 以後は張らない。走っているものの結果を捨てるのは呼ぶ側（`alive`）
 * - `stallMs` を過ぎても返らない `run` は見切って次を回す（#765 のレビュー。`fetch` に時間切れが無いので、切れた回線や
 *   詰まったサーバに掴まれた 1 本で、画面が二度と取り直さなくなる。見切った `run` があとで返っても次は張らない）
 *
 * `intervalMs()` が 0 以下なら張らない（隠れている間は止める）。`run` が投げても次は張る（失敗は呼ぶ側が持つ）
 */
export interface PollLoop {
  kick(): void
  rearm(): void
  stop(): void
}

/** これだけ返らなければ見切る。実測でサーバが詰まったときの応答は 8〜19 秒だったので、その数倍 */
export const POLL_STALL_MS = 60_000

export function pollLoop(run: () => Promise<void>, intervalMs: () => number, { stallMs = POLL_STALL_MS }: { stallMs?: number } = {}): PollLoop {
  let running = false
  let again = false
  let stopped = false
  /** 走っている run の番号。見切ったあとに返ってきた古い run を見分ける */
  let gen = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let stall: ReturnType<typeof setTimeout> | undefined

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const clearStall = () => {
    if (stall !== undefined) clearTimeout(stall)
    stall = undefined
  }
  const schedule = () => {
    clear()
    if (stopped) return
    const ms = intervalMs()
    if (ms > 0) timer = setTimeout(fire, ms)
  }
  const start = () => {
    clear()
    clearStall()
    running = true
    const mine = ++gen
    if (stallMs > 0) {
      stall = setTimeout(() => {
        // 返らないまま。見切って次へ（古い run の finally は gen が違うので何もしない）
        if (stopped || gen !== mine) return
        running = false
        again = false
        start()
      }, stallMs)
    }
    void (async () => {
      try {
        await run()
      } catch {
        // 失敗は呼ぶ側が state に持つ。ここでは次を張るだけ
      } finally {
        if (gen === mine) {
          clearStall()
          running = false
          if (!stopped) {
            if (again) {
              again = false
              start()
            } else {
              schedule()
            }
          }
        }
      }
    })()
  }
  const fire = () => {
    if (stopped) return
    if (running) {
      again = true
      return
    }
    start()
  }

  fire()
  return {
    kick: fire,
    rearm: () => {
      if (!running) schedule()
    },
    stop: () => {
      stopped = true
      clear()
      clearStall()
    },
  }
}
