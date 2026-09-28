// 発言ごとのメニュー（#503）の中身。発言へのリンクと、コピーする本文を組み立てる。
//
// 発言を名指しする鍵は **`ts` と「どちら側か」**。`Utterance.key`（`${ts}:${index}…`）は使わない:
// `index` は描いている行の中の位置なので、7 日の窓が動く・「前の 7 日を表示」で広げる（#477）とずれる。
// `ts` だけでも足りない（1 本の行から自分の入力と返答が同じ `ts` で 2 つ出る。`chatGroups.ts` の `…:me` と無印）
import { splitAttachments } from '../../shared/attachments.ts'
import { sessionHash, type MessageSide } from './hooks.ts'

/**
 * その発言へのリンク。開くとセッション画面でその発言まで送って光らせる（#230 の検索の飛び先と同じ口）。
 * 頭は**いま開いている SAI のもの**（ループバックなら `127.0.0.1`、tailnet の Serve 越しならそのホスト）。
 * `location.search` は足さない（SAI は使っていない。付いていても発言とは関係が無い）
 */
export function messageUrl(at: { origin: string; pathname: string }, id: string, ts: string, side: MessageSide): string {
  return `${at.origin}${at.pathname}${sessionHash(id, ts, side)}`
}

/**
 * コピーする本文。記録の文（エージェントなら Markdown の元の文。一言ではない）をそのまま渡す。
 * **自分の入力は添えた画像のパスを外す**（本文の末尾に足してあるだけで、画面でもサムネイルにして出していない。
 * パスはこのマシンの置き場を指すので、よそに貼っても開けない）
 */
export function messageCopyText(text: string, side: MessageSide): string {
  return side === 'me' ? splitAttachments(text).body : text
}

/**
 * このバブルが飛び先か。名指しした側だけ（#503。前は同じ `ts` の入力と返答が両方光っていた）。
 * `side` の無い飛び先（それより前に作ったリンク）は、その `ts` のどちらでも当たる
 */
export function isFocused(ts: string, side: MessageSide, focusTs: string, focusSide?: MessageSide): boolean {
  return focusTs !== '' && ts === focusTs && (!focusSide || focusSide === side)
}

/**
 * クリップボードに書く。書けなければ false（`navigator.clipboard` は安全なコンテキストでしか無い。
 * ループバックと Serve の `https://` は当てはまるが、tailnet の素の IP の `http://` では使えない）
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
