// unified diff（`git diff` の出力）を木にする。DOM に依存しないのでテストは node:test（shared/diff.test.ts）。
// 描画は web/src/DiffView.tsx。shared/markdown.ts と同じ形で、HTML 文字列は作らない。

/** サーバが大きすぎるファイルの本文を落としたときに差し込む印。パーサはこれを skipped として拾う */
export const SKIPPED_MARK = '*** 大きすぎるので本文は出しません ***'

/** 1行。`ctx` は前後の文脈。行番号は片側にしか無いことがあるので、無い方は 0 */
export interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
  oldNo: number
  newNo: number
}

/** `@@ -1,3 +1,4 @@ 見出し` のかたまり */
export interface DiffHunk {
  /** `@@ …` の行そのもの（後ろの見出しも含む） */
  header: string
  lines: DiffLine[]
}

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'binary' | 'other'

export interface DiffFile {
  path: string
  /** リネーム前。無ければ空 */
  oldPath: string
  status: DiffStatus
  /** 中身が出せない（バイナリ） */
  binary: boolean
  /** 大きすぎてサーバが本文を落とした */
  skipped: boolean
  hunks: DiffHunk[]
}

/** `a/src/x.ts` → `src/x.ts`。`/dev/null` は空。特殊文字を含むパスは引用符で囲まれる */
function stripPrefix(raw: string): string {
  let s = raw.trim()
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    // git は特殊文字を含むパスを C 風にエスケープして囲む。よくある \" \\ だけ戻す
    s = s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (s === '/dev/null') return ''
  return s.replace(/^[ab]\//, '')
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * `git diff` の出力をファイルごとに切って木にする。知らない行は読み飛ばす（壊れた出力でも落ちない）。
 * `diff --git` の外にある行は捨てる
 */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  for (const line of (patch ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { path: '', oldPath: '', status: 'modified', binary: false, skipped: false, hunks: [] }
      hunk = null
      files.push(file)
      // `diff --git a/x b/x`。--- / +++ が来ればそちらで上書きする
      const m = line.match(/^diff --git (.+) (.+)$/)
      if (m) {
        file.oldPath = stripPrefix(m[1]!)
        file.path = stripPrefix(m[2]!) || file.oldPath
      }
      continue
    }
    if (!file) continue
    if (line.startsWith('new file mode')) {
      file.status = 'added'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      file.status = 'deleted'
      continue
    }
    if (line.startsWith('rename from ')) {
      file.status = 'renamed'
      file.oldPath = stripPrefix(line.slice('rename from '.length))
      continue
    }
    if (line.startsWith('rename to ')) {
      file.status = 'renamed'
      file.path = stripPrefix(line.slice('rename to '.length))
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true
      continue
    }
    if (line.startsWith(SKIPPED_MARK)) {
      file.skipped = true
      continue
    }
    if (line.startsWith('--- ')) {
      const p = stripPrefix(line.slice(4))
      if (p) file.oldPath = p
      else {
        // `--- /dev/null` は新しいファイル。`diff --git` から入れた前の名前は無かったことにする
        file.status = 'added'
        file.oldPath = ''
      }
      continue
    }
    if (line.startsWith('+++ ')) {
      const p = stripPrefix(line.slice(4))
      if (p) file.path = p
      else file.status = 'deleted'
      continue
    }
    const m = line.match(HUNK)
    if (m) {
      oldNo = Number(m[1])
      newNo = Number(m[2])
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (line.startsWith('+')) hunk.lines.push({ kind: 'add', text: line.slice(1), oldNo: 0, newNo: newNo++ })
    else if (line.startsWith('-')) hunk.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: 0 })
    else if (line.startsWith(' ')) hunk.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    // `\ No newline at end of file` などはそのまま落とす
  }
  // path が取れなかったファイル（壊れた出力）は捨てる
  return files.filter((f) => f.path || f.oldPath)
}

/**
 * GitHub の compare の URL。差分が大きすぎて全部出せないときの逃げ道。
 * remote は record.py が正規化した `https://host/owner/repo`。base か head が無ければ空
 */
export function compareUrl(remote: string | undefined, base: string, head: string): string {
  const r = (remote ?? '').trim().replace(/\/+$/, '')
  if (!r || !base || !head || !r.startsWith('https://')) return ''
  // `origin/main` の `origin/` は URL では要らない
  const b = base.replace(/^origin\//, '')
  return `${r}/compare/${encodeURIComponent(b)}...${encodeURIComponent(head)}`
}
