// 画面から作る worktree の名前（#847）。ディレクトリ名とブランチ名の両方になるので、許す形を決め打ちにする。画面の打ちかけの案内とサーバの検査が同じものを見る

export const WORKTREE_NAME_MAX = 64

/** bare clone の直下に git が置くもの。worktree の置き場が bare 本体の直下のとき、作ると git の持ち物と混ざる（小文字で比べる。macOS は大文字小文字を区別しない） */
const RESERVED = new Set(['head', 'fetch_head', 'orig_head', 'merge_head', 'config', 'description', 'hooks', 'info', 'objects', 'refs', 'branches', 'logs', 'worktrees', 'modules', 'packed-refs', 'index', 'shallow', 'lfs'])

/**
 * 名前を断る理由。使えるなら空。**知っている文字だけを受ける**（英数字と `.`・`_`・`-`。先頭は英数字）ので、`/`・`..`・`-` 始まり・空白は通らない。
 * `.lock` と `.` で終わるものは git がブランチ名として断る
 */
export function worktreeNameRefusal(name: string): string {
  if (!name) return '名前を入れてください'
  if (name.length > WORKTREE_NAME_MAX) return `名前は ${WORKTREE_NAME_MAX} 字までです`
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return '名前に使えるのは英数字と . _ - で、先頭は英数字です'
  if (name.includes('..') || name.endsWith('.') || name.endsWith('.lock')) return 'その名前はブランチ名に使えません'
  if (RESERVED.has(name.toLowerCase())) return 'その名前は git が使っています'
  return ''
}
