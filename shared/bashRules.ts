// つないだ Bash のコマンド（`cd dir && pnpm test && pnpm lint | tail -5`）を部品に分け、「常に許可」で書く接頭辞を部品ごとに選ぶ（#705）。
// Claude Code はつないだコマンドを部品ごとに見て、**全部の部品が通ったときだけ**通す。先頭の 1 語だけのルールでは押しても次も聞かれた。
// Claude Code（2.1.287）で実機に試し、**通らなかった形は null**（[常に許可] を出さない）。
// 試した表は docs/history/approvals.md。DOM に依存しないので bashRules.test.ts を node:test で回す

/** サブコマンドを持つ CLI。`gh pr create` なら `gh pr` までを接頭辞にする（`gh` 全部を許すのは広すぎる） */
const SUBCOMMAND_CLIS = new Set([
  'gh', 'git', 'npm', 'pnpm', 'yarn', 'npx', 'bun', 'deno', 'node', 'python', 'python3', 'pip', 'pip3', 'uv', 'poetry',
  'docker', 'kubectl', 'cargo', 'go', 'make', 'brew', 'terraform', 'aws', 'gcloud', 'az', 'tailscale',
])

/** シェルの構文の語。先頭に来てもコマンドではないので、ルールにしても当たらない（`Bash(for:*)` を 5 回書いても聞かれ続けた） */
const KEYWORDS = new Set(['for', 'while', 'until', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'case', 'esac', 'select', 'function', 'time', 'coproc'])

/**
 * ルールが無くても聞かれなかった読むだけのコマンド（実機で `node -v | <これ>` を `Bash(node:*)` だけで通した）。
 * ルールを書いても害は無いが、書く範囲は聞かれるものだけにする。ここに無いものは書く側に倒れる（`awk` は聞かれた）。
 * **ほかに書くルールがあるときだけ**飛ばす（引数しだいで聞かれるので、これしか無いコマンドには書く）
 */
const UNASKED = new Set(['head', 'tail', 'grep', 'wc', 'sort', 'uniq', 'cat', 'cut', 'tr', 'echo', 'pwd', 'ls', 'true', 'sleep', 'date', 'which', 'jq'])

/**
 * `cd` と一緒につなぐと、ルールが揃っていても必ず聞かれるコマンド（Claude Code が「cd のあとはパスを確かめられない」として止める。
 * 書き込み系と `git`。本体の分類と同じ並び）。`chmod` / `ln` / `node` / `pnpm` は通った
 */
const NOT_AFTER_CD = new Set(['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed', 'tee', 'git'])

/** 捨ててよいリダイレクト: fd の付け替え（`2>&1`）と `/dev/null` への出し入れ。ファイルへ書くものはルールがあっても聞かれた */
const HARMLESS_REDIRECT = /^(?:\d*>&\d+|(?:\d*>>?|&>>?|<)\s*\/dev\/null(?![\w./-]))/

/** `"$(cat <<'EOF' … EOF )"`（コミットメッセージの定番）。この形だけは展開でも通った。中身ごと空の引用符に置き換える */
const QUOTED_HEREDOC = /"\$\(cat <<-?(['"])(\w+)\1\n[\s\S]*?\n[ \t]*\2\n?[ \t]*\)"/g

/**
 * ルールを組めなかった理由の**種類**（#724）。`approvals.jsonl` に残して、どの形が多いかを数える。
 * **種類だけ**で、コマンドの文字・引数・パスは持たない。判定は変えず、今まで null を返していた所に名前を付けただけ
 * - `expansion`: `$(…)`・`$VAR`・バッククォート（引用符の中も）
 * - `redirect`: ファイルへのリダイレクト・`|&` / `heredoc`: ヒアドキュメント（`<<`） / `background`: `&`
 * - `subshell`: `(` `)` / `brace`: `{` `}` / `comment`: 行の途中の `#` / `unclosed`: 閉じていない引用符・末尾の `\`
 * - `keyword`: `for` / `if` などの構文の語 / `odd_command`: 先頭の語がコマンドの名前の形でない / `env_value`: 代入の値に空白や記号
 * - `cd_form`: `cd` の形が読めない（引数が 1 つでない・`-`・`~`） / `cd_no_cwd`: `cwd` が分からない / `cd_outside`: 行き先が `cwd` の外
 * - `cd_then_write`: `cd` と書き込み系・`git` のつなぎ / `empty`: 部品が無い
 */
export type BashNoRuleReason =
  | 'expansion' | 'redirect' | 'heredoc' | 'background' | 'subshell' | 'brace' | 'comment' | 'unclosed'
  | 'keyword' | 'odd_command' | 'env_value' | 'cd_form' | 'cd_no_cwd' | 'cd_outside' | 'cd_then_write' | 'empty'

/** 部品に分ける。語は引用符を外した文字。切れない・通らない形（展開・サブシェル・ファイルへのリダイレクト・`&`）は理由の種類を返す */
function splitParts(command: string): string[][] | BashNoRuleReason {
  // 行の継続（`\` + 改行）は下で読み飛ばす。先に空白へ置き換えると、`\` で終わるコメント行の次の行まで捨ててしまう
  // （bash はコメントの中の `\` を継続にしない。#710 のレビュー）
  const text = command.replace(/\r\n/g, '\n').replace(QUOTED_HEREDOC, '""')
  const parts: string[][] = []
  let words: string[] = []
  let word: string | null = null
  const endWord = () => {
    if (word !== null) words.push(word)
    word = null
  }
  const endPart = () => {
    endWord()
    if (words.length > 0) parts.push(words)
    words = []
  }
  // 行の頭か（空白だけが前にある）。行ごとのコメントは通ったので読み飛ばし、行の途中の `#` は止める
  let lineStart = true
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '#' && word === null) {
      if (!lineStart) return 'comment'
      const end = text.indexOf('\n', i)
      i = (end < 0 ? text.length : end) - 1
      continue
    }
    if (c === '\n') lineStart = true
    else if (c !== ' ' && c !== '\t' && c !== '\r') lineStart = false
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) return 'unclosed'
      word = (word ?? '') + text.slice(i + 1, end)
      i = end
      continue
    }
    if (c === '"') {
      let body = ''
      let j = i + 1
      for (; j < text.length && text[j] !== '"'; j++) {
        const d = text[j]!
        if (d === '$' || d === '`') return 'expansion' // 引用符の中でも展開される
        if (d === '\\' && j + 1 < text.length) body += text[++j]!
        else body += d
      }
      if (j >= text.length) return 'unclosed'
      word = (word ?? '') + body
      i = j
      continue
    }
    if (c === '\\') {
      if (i + 1 >= text.length) return 'unclosed'
      if (text[i + 1] === '\n') {
        i++
        continue
      }
      word = (word ?? '') + text[++i]!
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      continue
    }
    if (c === '\n' || c === ';') {
      endPart()
      continue
    }
    if (c === '&' && text[i + 1] === '&') {
      endPart()
      i++
      continue
    }
    if (c === '|') {
      if (text[i + 1] === '&') return 'redirect'
      endPart()
      if (text[i + 1] === '|') i++
      continue
    }
    if (c === '>' || c === '<' || c === '&' || (/\d/.test(c) && word === null && /^\d+[<>]/.test(text.slice(i, i + 4)))) {
      const m = HARMLESS_REDIRECT.exec(text.slice(i))
      // ファイルへのリダイレクト・ヒアドキュメント・`&`（バックグラウンド）
      if (!m) return text.startsWith('<<', i) ? 'heredoc' : c === '&' && !/^&>/.test(text.slice(i, i + 2)) ? 'background' : 'redirect'
      endWord()
      i += m[0].length - 1
      continue
    }
    // 展開・サブシェル・波括弧
    if (c === '$' || c === '`') return 'expansion'
    if (c === '(' || c === ')') return 'subshell'
    if (c === '{' || c === '}') return 'brace'
    word = (word ?? '') + c
  }
  endPart()
  return parts
}

/** `/a/b/../c` → `/a/c`。node:path は画面で使えないので文字で畳む */
function normalize(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return `/${out.join('/')}`
}

const within = (dir: string, root: string) => dir === root || dir.startsWith(root === '/' ? '/' : `${root}/`)

/**
 * つないだコマンドの、部品ごとの接頭辞（`pnpm test` / `FOO=1 touch`）。重複は 1 つにまとめ、出てきた順。
 * **null は「このコマンドには [常に許可] を出さない」**: 1 つでもルールを作れない部品がある・全部の部品が通る見込みが無い。
 * 空の配列は「書くルールが無い」（`cd` しか無い）。
 *
 * - `cd` にはルールを作らない。プロジェクトの中への `cd` はルール無しで通り、外への `cd` は `Bash(cd:*)` があっても聞かれた
 *   （効くことが一度も無い）。行き先が `cwd` の外・`cwd` が分からないときは null
 * - `cd` と書き込み系・`git` をつないだものは null（ルールが揃っていても聞かれた）
 * - 環境変数の代入はそのまま接頭辞に入れる（`FOO=1 touch x` は `Bash(touch:*)` では通らず、`Bash(FOO=1 touch:*)` で通った）
 */
export function bashRulePrefixes(command: string, cwd: string): string[] | null {
  const plan = bashRulePlan(command, cwd)
  return 'reason' in plan ? null : plan.prefixes
}

/**
 * `bashRulePrefixes()` の中身（#724）。組めなかったときは null の代わりに**理由の種類**を返す。判定は同じ 1 つ
 * （`bashRulePrefixes()` はこれを呼ぶだけ）なので、[常に許可] を出すかと記録の理由がずれない
 */
export function bashRulePlan(command: string, cwd: string): { prefixes: string[] } | { reason: BashNoRuleReason } {
  const no = (reason: BashNoRuleReason) => ({ reason })
  const parts = splitParts(command)
  if (typeof parts === 'string') return no(parts)
  if (parts.length === 0) return no('empty')
  const prefixes: string[] = []
  // 読むだけのコマンドの接頭辞。ほかに書くルールが無いときだけ使う（下）
  const unasked: string[] = []
  const names: string[] = []
  let dir = cwd ? normalize(cwd) : ''
  let cd = false
  for (const words of parts) {
    const env: string[] = []
    let i = 0
    for (; i < words.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!); i++) {
      // 値に空白や記号があると、ルールの表記とコマンドの字面が揃わない
      if (!/^[A-Za-z_][A-Za-z0-9_]*=[\w./:@%+,-]*$/.test(words[i]!)) return no('env_value')
      env.push(words[i]!)
    }
    const first = words[i]!
    if (/[^\w./+-]/.test(first) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return no('odd_command')
    if (KEYWORDS.has(first)) return no('keyword')
    names.push(first)
    if (first === 'cd') {
      const target = words[i + 1]
      if (env.length > 0 || words.length !== i + 2 || !target || target.startsWith('-') || target.startsWith('~')) return no('cd_form')
      if (!dir) return no('cd_no_cwd')
      dir = normalize(target.startsWith('/') ? target : `${dir}/${target}`)
      if (!within(dir, normalize(cwd))) return no('cd_outside')
      cd = true
      continue
    }
    if (env.length === 0 && UNASKED.has(first)) {
      if (!unasked.includes(first)) unasked.push(first)
      continue
    }
    const second = words[i + 1]
    // 2 語目がフラグ（-x / --long）や記号なら 1 語で止める
    const head = SUBCOMMAND_CLIS.has(first) && second && /^[\w.][\w.-]*$/.test(second) ? `${first} ${second}` : first
    const prefix = [...env, head].join(' ')
    if (!prefixes.includes(prefix)) prefixes.push(prefix)
  }
  if (cd && names.some((n) => NOT_AFTER_CD.has(n))) return no('cd_then_write')
  // 読むだけのコマンドしか無いのに許可が来たなら、聞かれたのはその部品（`cat /etc/hosts` のように引数しだいで聞かれる）。
  // 書かないと、前は出ていた [常に許可] が消える（#710 のレビュー）
  return { prefixes: prefixes.length > 0 ? prefixes : unasked }
}
