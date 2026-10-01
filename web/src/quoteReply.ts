// 返答の一部を選んで、引用として返信欄に入れる（#604）。DOM に触らない純粋関数（quoteReply.test.ts）。
//
// 返答のバブルの中で文字を選ぶと「引用して返信」が出て、押すと打ちかけの末尾に Markdown の引用（`> …`）を足す。
// **画面から直接は送らない**（差分の行コメント #511 と同じ。足すだけで、送るのは人）。入力欄はただの textarea のまま

/** 1 つの引用の上限（字）。超えたら切って `…` を付ける（エージェントは自分の返答を覚えているので、場所が分かれば足りる） */
export const QUOTE_MAX_CHARS = 600

/** 選んだ場所。DOM から読み取った結果だけを渡す */
export interface QuoteSelection {
  /** 選択の始まりと終わりが同じバブルの中か */
  sameBubble: boolean
  /** そのバブルの側（`data-side`）。返答は `agent` */
  side: string
  /** 待ちのバブル（発言ではない） */
  waiting: boolean
  /** 選んだ文字 */
  text: string
}

/** 「引用して返信」を出すか。**1 つの返答のバブルの中**で、空白以外を選んでいるときだけ（自分の入力・待ち・バブルをまたいだ選択には出さない） */
export function quotable(s: QuoteSelection): boolean {
  return s.sameBubble && s.side === 'agent' && !s.waiting && s.text.trim() !== ''
}

/**
 * 選んだ文を Markdown の引用にする。行ごとに `> ` を付け（空行は `>`）、前後の空行と行末の空白は落とす。
 * 長すぎれば `QUOTE_MAX_CHARS` で切って `…` を付ける。空なら空文字
 */
export function quoteText(selected: string, max: number = QUOTE_MAX_CHARS): string {
  const lines = selected.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''))
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return ''
  let body = lines.join('\n')
  const chars = [...body]
  if (chars.length > max) body = `${chars.slice(0, max).join('').replace(/\s+$/, '')}…`
  return body
    .split('\n')
    .map((l) => (l === '' ? '>' : `> ${l}`))
    .join('\n')
}

/**
 * 返信欄に入れる文。引用の下に空行を置き、**カーソルが引用の下に来る**ようにする（続けて答えを打てる。
 * 続けて別の所を引用すれば、`appendInsert()` が前の末尾の空白を畳んで順に並べる）
 */
export function quoteInsert(selected: string): string {
  const quote = quoteText(selected)
  return quote ? `${quote}\n\n` : ''
}

/** ボタンを置く位置。選択の下の左端。画面からはみ出さないように寄せる */
export function quoteButtonPosition(rect: { left: number; bottom: number }, viewport: { width: number; height: number }, size = { width: 120, height: 30 }): { left: number; top: number } {
  const left = Math.max(8, Math.min(rect.left, viewport.width - size.width - 8))
  const top = Math.max(8, Math.min(rect.bottom + 6, viewport.height - size.height - 8))
  return { left: Math.round(left), top: Math.round(top) }
}
