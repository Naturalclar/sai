// 回っている Codex のコマンドの途中の出力（#846 の 2 つ目）。
//
// SAI が起こした stdio の app-server が回しているターンで、走っているコマンドの `item/commandExecution/outputDelta` を
// **メモリにだけ**ためる。ファイルにもログにも書かない（コマンドの出力には秘密が混ざりうる）。
// - コマンドごとに末尾 `LIVE_OUTPUT_MAX_CHARS` 字まで。超えたら古い方から捨て、捨てた字数だけ数える
// - 項目が終わったら（`item/completed`）捨てる。終わった出力は、ターンが終わったあと手順の「出力」（rollout を読む今の道）で開く
// - ターンが終わった・スレッドが閉じた・接続が切れたら、そのスレッドの分を全部捨てる
// - 1 つのスレッドで同時に持つのは `LIVE_COMMANDS_MAX` 本まで（それより多く走っても、あとの分はためない）
// 出すのは `GET /api/sessions/<id>/turn-output?live=1` だけ（`app.ts`）。`steps`・`/mcp` には載せない

/** コマンド 1 本でためる字数（仮に「末尾 64 KB」と決めた分。字で数える） */
export const LIVE_OUTPUT_MAX_CHARS = 64 * 1024
/** 1 つのスレッドで同時にためるコマンドの数 */
export const LIVE_COMMANDS_MAX = 8

/** 走っているコマンド 1 本の途中の出力 */
export interface LiveCommandOutput {
  /** app-server の項目の id */
  itemId: string
  /** 項目の `command`（分からなければ空） */
  command: string
  /** 項目が始まった時刻（ISO） */
  started: string
  /** 末尾の出力（最大 `LIVE_OUTPUT_MAX_CHARS` 字。制御列はそのまま） */
  text: string
  /** 上限を超えて捨てた頭の字数 */
  dropped: number
}

interface Entry {
  command: string
  started: string
  text: string
  dropped: number
}

export class CodexLiveOutputs {
  /** スレッド → 項目の id → ためている分 */
  private readonly threads = new Map<string, Map<string, Entry>>()

  /** コマンドの項目が始まった。上限の本数を超えていればためない */
  start(threadId: string, itemId: string, command: string, started: string): void {
    let items = this.threads.get(threadId)
    if (items?.has(itemId)) return
    if (!items) {
      items = new Map()
      this.threads.set(threadId, items)
    }
    if (items.size >= LIVE_COMMANDS_MAX) return
    items.set(itemId, { command, started, text: '', dropped: 0 })
  }

  /** 出力が届いた。始まりを見ていない項目の分は捨てる */
  append(threadId: string, itemId: string, delta: string): void {
    const entry = this.threads.get(threadId)?.get(itemId)
    if (!entry || !delta) return
    entry.text += delta
    // 届くたびに切ると 64K 字を毎回写すので、倍まで溜まってから切る
    if (entry.text.length > LIVE_OUTPUT_MAX_CHARS * 2) this.trim(entry)
  }

  /** 項目が終わった（終わった出力は rollout から読むので捨てる） */
  end(threadId: string, itemId: string): void {
    const items = this.threads.get(threadId)
    if (!items) return
    items.delete(itemId)
    if (items.size === 0) this.threads.delete(threadId)
  }

  /** ターンが終わった・スレッドが閉じた */
  clearThread(threadId: string): void {
    this.threads.delete(threadId)
  }

  /** 接続が切れた */
  clear(): void {
    this.threads.clear()
  }

  /** そのスレッドで走っているコマンドの途中の出力（始まった順） */
  of(threadId: string): LiveCommandOutput[] {
    const items = this.threads.get(threadId)
    if (!items) return []
    return [...items].map(([itemId, entry]) => {
      this.trim(entry)
      return { itemId, command: entry.command, started: entry.started, text: entry.text, dropped: entry.dropped }
    })
  }

  private trim(entry: Entry): void {
    const over = entry.text.length - LIVE_OUTPUT_MAX_CHARS
    if (over <= 0) return
    entry.text = entry.text.slice(over)
    entry.dropped += over
  }
}
