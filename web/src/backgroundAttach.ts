// `claude --bg` のセッション（#462）の見出し。DOM に依らないので node:test で回す（backgroundAttach.test.ts）
import type { BackgroundSession } from '../../shared/types.ts'

/** 端末で開くコマンド */
export function attachCommand(bg: BackgroundSession): string {
  return `claude attach ${bg.attach}`
}

/**
 * いまの状態の説明。**許可・質問は画面から答えられない**（`--permission-prompt-tool` が使われない）ので、
 * 端末で開くよう促す。SAI から送ると**誰も attach していなくてターンも終わっているときだけ**止めてから続ける
 * （`claude stop` は attach している端末をその場で閉じる。2026-09-24 に実測）
 */
export function backgroundNote(bg: BackgroundSession): string {
  if (!bg.live) return '止めてあります。端末で開くと起こし直せます'
  if (bg.status === 'waiting') return '許可・質問を待っています。端末で開いて答えてください'
  if (bg.status === 'busy') return 'バックグラウンドで回っています。終わるまで SAI からの返信は預かります'
  // 2.1.278 の `working` は「生きている」だけ。回っているか・誰かが開いているかはサーバが送るときに見る（#462）
  return 'SAI から送ると、誰も端末で開いていなくてターンも終わっていれば、止めてから続けます（開いていれば止めません）'
}
