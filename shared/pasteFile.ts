// 入力欄への長い貼り付けを、本文に入れずテキストファイルにして添える（#609）。判定と文言の純粋関数。
// 長い文が本文に入ると、そのセッションの以後のターンで毎回読み直される。ファイルにすれば、エージェントは要るときに要る所だけ読む。
// **貼り付けだけ**が対象（手で打った長い文は変えない）で、**設定で入にしたときだけ**（既定は切）。添付の仕組みは #608

/** これを**超える**貼り付けをファイルにする（字 = コードポイント）。記録の本文の上限（20,000 字）より下 */
export const PASTE_FILE_MIN_CHARS = 10_000
/** ファイルにした貼り付けの名前（エージェントに渡す行に添える・バブルに出す） */
export const PASTE_FILE_NAME = '貼り付けた文.txt'

/** 字数（コードポイント。絵文字のサロゲートペアは 1 字） */
export function pasteChars(text: string): number {
  let n = 0
  for (const _ of text) n++
  return n
}

/** その貼り付けをファイルにするか。設定が入で、しきい値を**超えた**ときだけ（ちょうどは本文のまま） */
export function pasteBecomesFile(text: string, enabled: boolean): boolean {
  // UTF-16 の長さはコードポイントの数以上なので、これ以下なら数えるまでもない
  if (!enabled || text.length <= PASTE_FILE_MIN_CHARS) return false
  return pasteChars(text) > PASTE_FILE_MIN_CHARS
}

/** 入力欄の並びに出す名前。`貼り付けた文（12,340 字）` */
export function pasteLabel(chars: number): string {
  return `貼り付けた文（${chars.toLocaleString('en-US')} 字）`
}

/** 「本文に戻す」。いまの本文の後ろに足す（空ならそのまま）。送りはしない */
export function restorePaste(current: string, pasted: string): string {
  return current.trim() === '' ? pasted : `${current.replace(/\s+$/, '')}\n${pasted}`
}

/** 確かめる用に出す頭の長さ（全部を DOM に入れない） */
export const PASTE_PREVIEW_CHARS = 4000

/** 中身を確かめる用の頭。切ったら残りの字数も返す */
export function pastePreview(text: string): { head: string; rest: number } {
  const chars = Array.from(text)
  return chars.length <= PASTE_PREVIEW_CHARS ? { head: text, rest: 0 } : { head: chars.slice(0, PASTE_PREVIEW_CHARS).join(''), rest: chars.length - PASTE_PREVIEW_CHARS }
}
