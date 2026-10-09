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

/**
 * `"$(cat <<'EOF' … EOF )"`（コミットメッセージの定番）の頭。この形だけは展開でも通った。中身ごと空の語として読む。
 * **走査の中で、二重引用符に当たった位置でだけ**見る（全文に先に置換を掛けると、読み飛ばすヒアドキュメントの本文やコメントの中の
 * 同じ字面まで畳んで、その間のコマンドを見落とす。#751 のレビュー）
 */
const QUOTED_HEREDOC_OPEN = /^"\$\(cat <<(-?)(['"])(\w+)\2\n/

/**
 * ルールを組めなかった理由の**種類**（#724）。`approvals.jsonl` に残して、どの形が多いかを数える。
 * **種類だけ**で、コマンドの文字・引数・パスは持たない。
 * **1 行に残るのは、頭から読んで最初に当たった 1 つ**（`echo $(x) > out` は `expansion` だけ）。
 * - `expansion`: `$(…)`・`$VAR`・バッククォート（引用符の中も）
 * - `redirect`: ファイルへのリダイレクト・`|&` / `heredoc`: 組まないヒアドキュメント（`<<`。目印を囲んでいない・目印のあとに続きがある・
 *   閉じの行が無い・本文を文章として受け取るコマンド（`gh` / `git`）でない） / `here_string`: `<<<` / `background`: `&`
 * - `subshell`: 引用符の外の `(` `)`（`<(…)` `>(…)` も） / `brace`: 引用符の外の `{` `}`（波括弧の組のほか `HEAD@{1}`・`-exec … {}` も）
 * - `comment`: 行の途中の `#` / `unclosed`: 閉じていない引用符・末尾の `\`
 * - `keyword`: `for` / `if` などの構文の語 / `assign_only`: 代入だけでコマンドが無い（`FOO=1`）
 * - `odd_command`: 先頭の語がコマンドの名前の形でない（`[`・`!`・`~/bin/x` など）。`\r` の混ざったコマンドもここ / `env_value`: 代入の値に空白や記号
 * - `cd_form`: `cd` の行き先が読めない（引数が 1 つでない・`-`・`*` `?` `[` を含む・`~user`・引用符つきの `~`・ホームが分からないときの `~`・
 *   最初の部品でない `cd ~/…`・`pushd` / `popd`・`command cd` / `builtin cd`・`CDPATH` に触った部品や `source` / `.` / `eval` のあとの相対の `cd`） / `cd_no_cwd`: `cwd` が分からない / `cd_outside`: 行き先が `cwd` の外
 * - `cd_then_write`: `cd` と書き込み系・`git` のつなぎ / `empty`: 部品が無い
 */
export const BASH_NO_RULE_REASONS = [
  'expansion', 'redirect', 'heredoc', 'here_string', 'background', 'subshell', 'brace', 'comment', 'unclosed',
  'keyword', 'assign_only', 'odd_command', 'env_value', 'cd_form', 'cd_no_cwd', 'cd_outside', 'cd_then_write', 'empty',
] as const
export type BashNoRuleReason = (typeof BASH_NO_RULE_REASONS)[number]

/**
 * 目印を引用符で囲んだヒアドキュメント（`<<'EOF'` / `<<"EOF"` / `<<-'EOF'`）で、**目印がその行の最後**のもの（#724）。
 * 実機（Claude Code 2.1.292）で、この形はコマンドのルールだけで通った（本文は展開されないので、中の `$(…)` や `&&` は見られない）。
 * 目印を囲んでいないもの（本文が展開される）・目印のあとに `| head` `2>&1` `&& x` が続くものは、ルールがあっても聞かれた。
 * 受けるのは標準入力（fd なしか `0`）だけ（`3<<'EOF'` は本文が `--body-file -` に渡らない）
 */
const QUOTED_TAG_HEREDOC = /^0?<<(-?)[ \t]*(['"])(\w+)\2[ \t]*(?=\n)/

/**
 * ヒアドキュメントを渡してもルールを組む形（#724）。**本文を文章として受け取ると分かっている形だけ**:
 * - `gh issue|pr|release create|comment|edit|review … --body-file -`（`-F -`・`--body-file=-` も）
 * - `git commit … -F -`（`--file -`・`--file=-` も）
 *
 * 先頭の語だけでは決めない（`git apply <<'EOF'`・`gh auth login --with-token <<'EOF'`・`git -c alias.x=!sh x <<'EOF'` は、
 * 本文を操作やコードとして受け取る。#751 のレビュー）。`python3 - <<'EOF'` や `bash <<'EOF'` も実機では通ったが、
 * ルールにすると `Bash(python3:*)`（何でも実行できる）になり、聞かれた 1 回の中身（本文）と書かれる範囲が釣り合わないので組まない。
 * `words` はその部品の語（代入は付いていないこと。代入つきは断る）
 */
function takesHeredocAsText(words: readonly string[]): boolean {
  const stdinFile = (flags: readonly string[]) => words.some((w, i) => (flags.includes(w) && words[i + 1] === '-') || flags.some((f) => f.startsWith('--') && w === `${f}=-`))
  if (words[0] === 'gh') return ['issue', 'pr', 'release'].includes(words[1] ?? '') && ['create', 'comment', 'edit', 'review'].includes(words[2] ?? '') && stdinFile(['--body-file', '-F'])
  if (words[0] === 'git') return words[1] === 'commit' && stdinFile(['--file', '-F'])
  return false
}

/** 捨てられないリダイレクトの種類。`rest` はその記号から先（頭の fd の数字も含む） */
function redirectReason(rest: string): BashNoRuleReason {
  const op = rest.replace(/^\d+/, '')
  if (op.startsWith('<<<')) return 'here_string'
  if (op.startsWith('<<')) return 'heredoc'
  if (/^[<>]\(/.test(op)) return 'subshell'
  if (op.startsWith('&') && !op.startsWith('&>')) return 'background'
  return 'redirect'
}

interface SplitParts {
  parts: string[][]
  /**
   * 引用符やバックスラッシュが混ざった語（`<部品の番号>:<語の番号>`）。`~` で始まっていても bash は展開しないので、
   * `cd '~/x'` をホームに読み替えない（語は引用符を外した文字で持つので、ここで覚えておく。#751 のレビュー）
   */
  quoted: Set<string>
  /** `"$(cat <<'EOF' … )"` を空として畳んだ語（同じ鍵）。中身を読んでいないので、`cd` の行き先・コマンドの名前には使わせない */
  folded: Set<string>
}

/** 部品に分ける。語は引用符を外した文字。切れない・通らない形（展開・サブシェル・ファイルへのリダイレクト・`&`）は理由の種類を返す */
function splitParts(command: string): SplitParts | BashNoRuleReason {
  // 行の継続（`\` + 改行）は下で読み飛ばす。先に空白へ置き換えると、`\` で終わるコメント行の次の行まで捨ててしまう
  // （bash はコメントの中の `\` を継続にしない。#710 のレビュー）
  // `\r` の混ざったコマンドは組まない。bash は `\r` を語の文字として読むので（`EOF\r` の行はヒアドキュメントを閉じない・`a\rb` は 1 語）、
  // 空白や改行として読むと、本文の中の文字をコマンドとして拾う（#751 のレビュー）
  if (command.includes('\r')) return 'odd_command'
  const text = command
  const parts: string[][] = []
  const quoted = new Set<string>()
  const folded = new Set<string>()
  // いまの語・いまの部品に、畳んだ `"$(cat <<…)"` が混ざったか
  let wordFolded = false
  let partFolded = false
  let words: string[] = []
  let word: string | null = null
  // いまの語に引用符・バックスラッシュが混ざったか
  let wordQuoted = false
  const endWord = () => {
    if (word !== null) {
      if (wordQuoted) quoted.add(`${parts.length}:${words.length}`)
      if (wordFolded) folded.add(`${parts.length}:${words.length}`)
      words.push(word)
    }
    word = null
    wordQuoted = false
    wordFolded = false
  }
  const endPart = () => {
    endWord()
    if (words.length > 0) parts.push(words)
    words = []
    partFolded = false
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
    else if (c !== ' ' && c !== '\t') lineStart = false
    // 行の継続（`\\` + 改行）は語に何も足さないので数えない
    if (c === "'" || c === '"' || (c === '\\' && text[i + 1] !== '\n')) wordQuoted = true
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) return 'unclosed'
      word = (word ?? '') + text.slice(i + 1, end)
      i = end
      continue
    }
    if (c === '"') {
      // `"$(cat <<'EOF' … EOF)"` は中身ごと空の語として読む（この形だけは展開でも通った）
      // 頭の字面が合うときだけ残りを写して確かめる（引用符のたびに残り全部を写さない）
      const wrapped = text.startsWith('"$(cat <<', i) ? quotedCatHeredocEnd(text.slice(i)) : -1
      if (wrapped > 0) {
        word = word ?? ''
        wordFolded = true
        partFolded = true
        i += wrapped - 1
        continue
      }
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
    if (c === ' ' || c === '\t') {
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
      const rest = text.slice(i)
      const m = HARMLESS_REDIRECT.exec(rest)
      if (!m) {
        // 引用符つきの目印のヒアドキュメントは、本文ごと読み飛ばす（閉じの行が無ければ今までどおり断る）
        const end = quotedHeredocEnd(rest)
        if (end < 0) return redirectReason(rest) // ファイルへのリダイレクト・読めないヒアドキュメント・`&`（バックグラウンド）
        endWord()
        // 渡してよい形かは**ここで**決める（目印のあとに語は続かないので、部品の語はもう全部読めている）。
        // あとで決めると、閉じたあとの行の別の理由が先に返って、記録の「頭から読んで最初に当たった 1 つ」が崩れる（#751 のレビュー）
        // 前にあるのが `cd` だけのときしか組まない: 前の部品が `gh` / `git` の実体を差し替えていても見抜けない
        // （`eval 'gh() { sh; }'`・`alias gh=sh`・`export PATH=…`・`source x.sh`。本文がコードとして走る。#751 のレビュー）。
        // 畳んだ語（中身を読んでいない）が混ざった部品も、見えている語と実際の語がずれるので組まない
        if (partFolded || parts.some((p) => p[0] !== 'cd') || !takesHeredocAsText(words)) return 'heredoc'
        i += end - 1 // 閉じの行の終わり。次の改行で部品が終わる
        continue
      }
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
  return { parts, quoted, folded }
}

/**
 * ヒアドキュメントの本文が終わる所（閉じの行の終わり）を、`from`（本文の頭の直前の改行）から探す。無ければ -1。
 * 閉じるのは bash と同じ **最初の「目印だけの行」**（`<<-` のときだけ頭のタブを許す）。探し方はこの 1 つだけ
 * （2 つの読み方が別々に持つと、片方だけ直してずれる。#751 のレビュー）
 */
function heredocBodyEnd(rest: string, from: number, dash: boolean, tag: string): number {
  const close = new RegExp(`\\n${dash ? '\\t*' : ''}${tag}(?=\\n|$)`).exec(rest.slice(from))
  return close ? from + close.index + close[0].length : -1
}

/**
 * `rest`（`<<` から先）が引用符つきの目印のヒアドキュメントなら、閉じの行の終わりまでの長さを返す。違う・閉じの行が無いなら -1
 */
function quotedHeredocEnd(rest: string): number {
  const m = QUOTED_TAG_HEREDOC.exec(rest)
  return m ? heredocBodyEnd(rest, m[0].length, m[1] === '-', m[3]!) : -1
}

/**
 * `rest` が `"$(cat <<'EOF'\n … \nEOF\n)"` なら、閉じの `"` までの長さを返す。違う・閉じが無いなら -1。
 * **本文は最初の「目印だけの行」で閉じ、そのすぐ次が `)"`**（頭の空白は可）のときだけ。
 * 字下げした目印の行で閉じたことにしたり、最初の目印の行のあとに別のコマンドが続くもの（`$(…)` の中でまだ何か走る）まで畳んだりすると、
 * そのコマンドを見落とす（#751 のレビュー）
 */
function quotedCatHeredocEnd(rest: string): number {
  const m = QUOTED_HEREDOC_OPEN.exec(rest)
  if (!m) return -1
  const end = heredocBodyEnd(rest, m[0].length - 1, m[1] === '-', m[3]!)
  if (end < 0) return -1
  const tail = /^\n[ \t]*\)"/.exec(rest.slice(end))
  return tail ? end + tail[0].length : -1
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
export function bashRulePrefixes(command: string, cwd: string, home: string): string[] | null {
  const plan = bashRulePlan(command, cwd, home)
  return 'reason' in plan ? null : plan.prefixes
}

/**
 * `bashRulePrefixes()` の中身（#724）。組めなかったときは null の代わりに**理由の種類**を返す。判定は同じ 1 つ
 * （`bashRulePrefixes()` はこれを呼ぶだけ）なので、[常に許可] を出すかと記録の理由がずれない
 */
export function bashRulePlan(command: string, cwd: string, home: string): { prefixes: string[] } | { reason: BashNoRuleReason } {
  const no = (reason: BashNoRuleReason) => ({ reason })
  const split = splitParts(command)
  if (typeof split === 'string') return no(split)
  const { parts, quoted, folded } = split
  // 前の部品が `cd` の探し方を変えたかもしれない（`CDPATH` に触った・中身の見えない `source` / `.` / `eval`）。そのあとの相対の `cd` は行き先が読めない
  let cdPathTouched = false
  if (parts.length === 0) return no('empty')
  const prefixes: string[] = []
  // 読むだけのコマンドの接頭辞。ほかに書くルールが無いときだけ使う（下）
  const unasked: string[] = []
  const names: string[] = []
  let dir = cwd ? normalize(cwd) : ''
  let cd = false
  for (const [index, words] of parts.entries()) {
    const env: string[] = []
    let i = 0
    for (; i < words.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!); i++) {
      // 値に空白や記号があると、ルールの表記とコマンドの字面が揃わない
      if (!/^[A-Za-z_][A-Za-z0-9_]*=[\w./:@%+,-]*$/.test(words[i]!)) return no('env_value')
      env.push(words[i]!)
    }
    const first = words[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return no('assign_only')
    // 空の語（`""`）・中身を読んでいない畳んだ語は、コマンドの名前として読まない（空の接頭辞のルールを書かない。#751 のレビュー）
    if (!first || folded.has(`${index}:${i}`) || /[^\w./+-]/.test(first)) return no('odd_command')
    if (KEYWORDS.has(first)) return no('keyword')
    names.push(first)
    // 場所を変えるほかの形（`pushd` / `popd`・`command cd`・`builtin cd`）は、行き先を追っていないので読めない形にする
    if (first === 'pushd' || first === 'popd' || ((first === 'command' || first === 'builtin') && ['cd', 'pushd', 'popd'].includes(words[i + 1] ?? ''))) return no('cd_form')
    if (first === 'cd') {
      let target = words[i + 1]
      // 行き先に `*` `?` `[` があると、シェルが別のパスに開く（字面で中か外かを決められない）
      if (env.length > 0 || words.length !== i + 2 || !target || target.startsWith('-') || /[*?[]/.test(target) || folded.has(`${index}:${i + 1}`)) return no('cd_form')
      if (target.startsWith('~')) {
        // `~` と `~/…` はホームに読み替える（実機で、プロジェクトの中へ行く `cd ~/…` は中への `cd` と同じく通った。#724）。
        // **コマンドの最初の部品のときだけ**: 前に何かあると、そこで HOME が変わっていても見抜けない
        // （`export HOME=/x`・`HOME+=…`・`command source env.sh`・`X=1 eval …`。触り方を 1 つずつ追うのをやめた。#751 のレビュー）。
        // ホームが分からない・`~user`・引用符つきの `~`（bash は展開しない）も、今までどおり読めない形
        if (!home || index !== 0 || quoted.has(`${index}:${i + 1}`) || (target !== '~' && !target.startsWith('~/'))) return no('cd_form')
        target = `${normalize(home)}${target.slice(1)}`
      } else if (!target.startsWith('/') && cdPathTouched) {
        return no('cd_form')
      }
      if (!dir) return no('cd_no_cwd')
      dir = normalize(target.startsWith('/') ? target : `${dir}/${target}`)
      if (!within(dir, normalize(cwd))) return no('cd_outside')
      cd = true
      continue
    }
    if (words.some((w) => /^CDPATH(?:\+?=|$)/.test(w)) || ['source', '.', 'eval'].includes(first)) cdPathTouched = true
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
