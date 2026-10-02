// 人に判断・回答を求めている返答か（#638）。当たった返答は一言（digest）に言い換えず、本文をそのまま出す。
// LLM は呼ばない純粋関数（`digestIssues()` と同じ置き方）。本文だけで決め、fullText.test.ts で回す。
//
// **狭い方に倒す**: 当たらなかった返答を一言にするのは今までと同じで害が無い。当たりすぎると一言が出なくなる。
// なので見るのは 2 つだけ——「決めてほしいこと」の類の見出し・太字があるか、本文の最後の段落に問いかけがあるか。
// 途中の「？」・引用・コードの中の「?」・表の中は見ない

/** 「決めてほしいこと」の類。見出し・太字・行頭の項目名のときだけ当てる（文の途中に出てくるだけでは当てない） */
const DECIDE = /(?:決めてほしい|決めて欲しい|決めること|決めたいこと|判断してほしい|判断して欲しい|判断がほしい|確認したいこと|確認してほしいこと|教えてほしいこと|選んでほしい|選んでください|質問があります|質問です|聞きたいこと)/

/** 最後の文が問いかけか。疑問符で終わるか、「〜ますか」「〜でしょうか」などで終わる */
const ASKS = /(?:[?？]|(?:ますか|ですか|でしょうか|ましょうか|どうしますか|どちらにしますか|よいですか|いいですか|よろしいですか)[。.]?)$/

/** 見出しに語があっても、もう残っていない・決まったと言っている行（「決めることは残っていません」） */
const SETTLED = /(?:ありません|残っていません|無い|ない|なし|済み|決まりました|決めました|ませんでした)/

/** 落とした行（コード・引用・表）の代わりに置く印。**空行にしない**（空行にすると、表で終わる返答の「最後の段落」が表の前の段落になる） */
const DROPPED = '[-]'

/** コード・引用・表を落とす（その中の「?」や語は、人への問いかけではない）。URL とインラインコードも外す */
function proseLines(text: string): string[] {
  const out: string[] = []
  let fenced = false
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      out.push(DROPPED)
      continue
    }
    if (fenced || /^\s*>/.test(line) || /^\s*\|.*\|\s*$/.test(line)) {
      out.push(DROPPED)
      continue
    }
    // URL の `?days=7` を問いかけにしない
    out.push(line.replace(/`[^`\n]*`/g, '').replace(/https?:\/\/\S+/g, ''))
  }
  return out
}

/** 行の飾り（見出し・箇条書き・太字・末尾の閉じ括弧や絵文字でない記号）を外した中身 */
function bare(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/\*\*|__/g, '')
    .replace(/[\s）)」』】*_]+$/u, '')
    .trim()
}

/** 見出し・太字・「〜:」で終わる項目名として DECIDE の語が出ているか */
function hasDecideHeading(lines: string[]): boolean {
  return lines.some((line) => {
    if (!DECIDE.test(line) || SETTLED.test(line)) return false
    const t = line.trim()
    if (/^#{1,6}\s/.test(t)) return true
    // 太字の中に語がある（`**決めてほしいこと**` / `**決めること（2 つ）**:`）
    if ([...t.matchAll(/\*\*([^*]+)\*\*/g)].some((m) => DECIDE.test(m[1] ?? ''))) return true
    // 短い行が「:」で終わる（項目名）
    return t.length <= 30 && /[:：]$/.test(t)
  })
}

/** 文に分ける。句点と、疑問符のあとで切る（「どれにしますか？ どれでも構いません。」の前半を拾う） */
function sentences(line: string): string[] {
  return bare(line)
    // 半角の「?」は後ろが空白か行末のときだけ文の終わり（`name?: string` のような書き方を切らない）
    .split(/(?<=[。？])|(?<=\?)(?=\s)/u)
    .map((t) => t.trim())
    .filter(Boolean)
}

/**
 * 本文の**最後の段落**（空行で区切った最後のかたまり）に、問いかけで終わる文があるか。
 * 最後の行だけを見ると、番号つきで並べた問いかけ・「どれにしますか？ どれでも構いません。」を落とす
 */
function lastParagraphAsks(lines: string[]): boolean {
  let end = lines.length - 1
  while (end >= 0 && !(lines[end] ?? '').trim()) end--
  for (let i = end; i >= 0 && (lines[i] ?? '').trim(); i--) {
    if (sentences(lines[i] ?? '').some((t) => ASKS.test(t))) return true
  }
  return false
}

/**
 * 人に判断・回答を求めている返答か。当たれば一言を作らず本文をそのまま出す（#638）
 */
export function needsFullText(text: string): boolean {
  if (!text.trim()) return false
  const lines = proseLines(text)
  return hasDecideHeading(lines) || lastParagraphAsks(lines)
}
