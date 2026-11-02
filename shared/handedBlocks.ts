// SAI が本文の頭に足す塊（返答 #594・その後 #827）の印と、それを外す関数。`shared/reply.ts` からも使うので、
// 循環しないように何も import しない（`shared/agentMessages.ts` は `reply.ts` を import している）

/** 送り元の次のターンの頭に足す返答の塊の始まり。`【SAI】` で始めない（`deliveredId()` が届けた見出しと取り違えないように） */
export const HANDED_MARK = '【SAI 返答】'
/** 塊の終わり。ここから後ろが人（か預かり）の本文 */
export const HANDED_END = '【SAI 返答ここまで。以下が今回の指示です】'
/**
 * 頼んだ件の「その後」（#827。`shared/agentAfter.ts`）の塊の始まりと終わり。返答の塊のあと、人の本文の前に置く。
 * `【SAI】` で始めない（`deliveredId()` が届けた見出しと取り違えないように）。外す側（`splitHandedReplies()`）と同じここに置く
 */
export const AFTER_MARK = '【SAI その後】'
export const AFTER_END = '【SAI その後ここまで】'

/**
 * 本文の頭に足した返答の塊（#594）と「その後」の塊（#827）を外す。画面の自分のバブル・題名・↑ の履歴は人が打った文だけを見せる。
 * 記録の `user_text` には塊ごと残る（SAI は行を書き換えない）。塊が無ければ `handed: 0`・`after: 0` でそのまま
 */
export function splitHandedReplies(userText: string): { text: string; handed: number; after: number } {
  let text = userText
  let handed = 0
  if (text.startsWith(HANDED_MARK)) {
    const end = text.indexOf(HANDED_END)
    if (end < 0) return { text: userText, handed: 0, after: 0 }
    handed = Number(/返答が (\d+) 件届いています/.exec(text.slice(0, 200))?.[1] ?? 0)
    text = text.slice(end + HANDED_END.length).replace(/^\s+/, '')
  }
  // 頼んだ件の「その後」（#827）は返答の塊のあと（無ければ頭）に置かれる。数はターンの行・「ほか N ターン」・閉じたことの行を合わせた件数
  let after = 0
  if (text.startsWith(AFTER_MARK)) {
    const end = text.indexOf(AFTER_END)
    if (end >= 0) {
      const block = text.slice(0, end)
      after = (block.match(/^- (?:\d+\/\d+ |#\d+ は)/gm) ?? []).length + [...block.matchAll(/^- ほか (\d+) ターン/gm)].reduce((n, m) => n + Number(m[1]), 0)
      text = text.slice(end + AFTER_END.length).replace(/^\s+/, '')
    }
  }
  return { text, handed, after }
}
