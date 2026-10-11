/**
 * 「返ってから次を張る」ポーリングのループ（#765）。
 *
 * `setInterval` だと前の要求が返る前に次を投げるので、サーバが間隔より遅れると未返答の要求が積み上がり、
 * サーバは 1 本ごとに集計をやり直してさらに遅れる循環に入る（実測: 接続 250 本・`/api/sessions` が 110 秒でも返らない）。
 * ここでは `run` が終わってから `intervalMs()` 後に次を張るので、走っている要求は同時に 1 本までになる。
 *
 * - `kick()`: いま 1 回（走っていれば、終わった直後にもう 1 回）。タブに戻ったときの「待たずに 1 回」
 * - `rearm()`: 次までの間隔を取り直す（表と裏で間隔が違う）。走っている間は、終わったときに取り直すので何もしない
 * - `stop()`: 以後は張らない。走っているものの結果を捨てるのは呼ぶ側（`alive`）
 *
 * `intervalMs()` が 0 以下なら張らない（隠れている間は止める）。`run` が投げても次は張る（失敗は呼ぶ側が持つ）
 */
export interface PollLoop {
  kick(): void
  rearm(): void
  stop(): void
}

export function pollLoop(run: () => Promise<void>, intervalMs: () => number): PollLoop {
  let running = false
  let again = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const schedule = () => {
    clear()
    if (stopped) return
    const ms = intervalMs()
    if (ms > 0) timer = setTimeout(fire, ms)
  }
  const fire = () => {
    if (stopped) return
    if (running) {
      again = true
      return
    }
    clear()
    running = true
    void (async () => {
      try {
        await run()
      } catch {
        // 失敗は呼ぶ側が state に持つ。ここでは次を張るだけ
      } finally {
        running = false
        if (!stopped) {
          if (again) {
            again = false
            fire()
          } else {
            schedule()
          }
        }
      }
    })()
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
    },
  }
}
