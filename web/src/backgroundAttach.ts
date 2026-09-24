// `claude --bg` のセッション（#462）の見出し。DOM に依らないので node:test で回す（backgroundAttach.test.ts）
import type { BackgroundSession } from '../../shared/types.ts'

/** 端末で開くコマンド */
export function attachCommand(bg: BackgroundSession): string {
  return `claude attach ${bg.attach}`
}

/**
 * いまの状態の説明。**許可・質問は画面から答えられない**（`--permission-prompt-tool` が使われない）ので、
 * 端末で開くよう促す。**SAI からは止めない**（`claude stop` は attach している端末をその場で閉じる。
 * 2026-09-24 に実測）ので、生きている間の返信は預かりに回る
 */
export function backgroundNote(bg: BackgroundSession): string {
  if (!bg.live) return '止めてあります。端末で開くと起こし直せます'
  if (bg.status === 'waiting') return '許可・質問を待っています。端末で開いて答えてください'
  if (bg.status === 'busy') return 'バックグラウンドで回っています。終わるまで SAI からの返信は預かります'
  // 2.1.278 の `working` は「生きている」だけで、ターンが回っているかまでは分からない（#462）
  return '端末で開いて打ってください。生きている間は SAI から送れません（送ったぶんは預かります）'
}
