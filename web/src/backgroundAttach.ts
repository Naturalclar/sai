// `claude --bg` のセッション（#462）の見出し。DOM に依らないので node:test で回す（backgroundAttach.test.ts）
import type { BackgroundSession } from '../../shared/types.ts'

/** 端末で開くコマンド */
export function attachCommand(bg: BackgroundSession): string {
  return `claude attach ${bg.attach}`
}

/**
 * いまの状態の説明。**許可・質問は画面から答えられない**（`--permission-prompt-tool` が使われない）ので、
 * 待っているときは端末で開くよう促す。入力待ちのときは、SAI から送ると止めてから続けることも書く（止めても会話は残る）
 */
export function backgroundNote(bg: BackgroundSession): string {
  if (!bg.live) return '止めてあります。端末で開くと起こし直せます'
  if (bg.status === 'waiting') return '許可・質問を待っています。端末で開いて答えてください'
  if (bg.status === 'busy') return 'バックグラウンドで回っています。終わるまで SAI からの返信は預かります'
  return 'バックグラウンドで入力を待っています。SAI から送ると、止めてから続けます（attach している端末は閉じます）'
}
