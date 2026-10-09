// 「読むだけ」と分かっている Bash のコマンドか（#749）。
//
// [常に許可] のルールを作れない Bash の許可を、Jev の確率が閾値以上なら今回だけ自動で通す（`shared/jev.ts` の `jevAutoDecision()`）。
// 確率だけに任せず、**形でも縛る**。はじめは「通さない形の一覧に当たらなければ通す」で作ったが、別の目のレビューで
// すり抜けが 20 種類以上見つかった（シェルの読み方を自前で書くと必ず食い違う・拒否の一覧は必ず漏れる）。
// ここは逆向き: **知っている構文と、知っているコマンド・フラグだけを受ける。それ以外は全部「人に回す」。**
//
// - 読めない字が 1 つでもあれば通さない（変数 `$X`・`${…}`・`$'…'`・バッククォート・バックスラッシュ・波括弧・ヒアドキュメント・
//   ファイルへのリダイレクト・`&`・代入・関数・`for` / `if`・プロセス置換・引用符の外の非 ASCII・`\r`）
// - 受ける構文: 語（素の字・`'…'`・`"…"`）、`&&` `||` `;` 改行 `|`、サブシェル `( … )`、コマンド置換 `$( … )`、
//   行のコメント（空白のあとの `#`）、捨てるだけのリダイレクト（`2>&1`・`>/dev/null`・`2>/dev/null`・`&>/dev/null`）
// - 受けるコマンド: 下の `COMMANDS` にあるものだけ。フラグも 1 つずつ「知っているもの」だけ
// - ファイルを読むコマンドの引数は、cwd の中で、秘密のファイル（`shared/files.ts` の `isSecretPath()`）でないものだけ
// - `$( … )` の結果（中身が分からない語）を渡してよいのは `echo` だけで、二重引用符の中に書いたもの（`echo "$(…)"`）だけ
// - シェルが展開する語（引用符の外のグロブ・`~`）は受けない（`ls` の引数だけ受ける）
//
// **多機能なコマンドは入れない**（3 回のレビューで、漏れは毎回そこから出た）: `printf`（`-v` が変数に書く）・`jq`（式が環境変数を出せる・
// 終わらない）・`rg`（下へ潜って秘密らしい名前のファイルも読む）・`cd`（`CDPATH` や別名で行き先が変わる）・`diff`（ディレクトリの中身を出す）・
// `git grep`（`-O` がページャを走らせる）・`git -C`・gh の `--jq`。
//
// 残っている限界（ここでは分からないこと）:
// - セッションの cwd と、実際にシェルが居る場所のずれ（人が前に許可した `cd`）。cwd の中のシンボリックリンク
// - 名前で秘密と分からないファイル（`token`・`kubeconfig`・`.mcp.json` など、`isSecretPath()` が見ないもの）
// - 追跡されている秘密（`git log -p`・`git show` は履歴の中身を出す）。git 自身の設定で走るもの（`diff.external`・`core.fsmonitor`。利用者の設定）
// - 利用者のシェルの別名・関数（`cat` を別のコマンドにしている、など。zsh は対話でなくてもスナップショットの別名を使う）
//
// 漏れたときに通るのは「知っている読むだけのコマンド」に限られる。効く範囲は狭い（`git commit` に渡す展開などは人に来る）。
// DOM に依存しないので bashReadOnly.test.ts を node:test で回す
import { normalize, within } from './bashRules.ts'
import { isSecretPath } from './files.ts'

/** 通さなかった理由の種類。`reply.log` に残す（コマンドの文字は書かない） */
export type NotReadOnly =
  | 'syntax' // 読める構文でない（変数・バッククォート・リダイレクト・ヒアドキュメント・代入・構文の語など）
  | 'command' // 読むだけと分かっているコマンドでない
  | 'flag' // そのコマンドの、知らないフラグ・引数の形
  | 'path' // cwd の外・行き先が読めない・グロブ
  | 'secret' // 秘密が入っていそうなファイル（`.env`・鍵・トークン）
  | 'opaque' // `$( … )` の結果を、`echo` 以外に渡している

export const NOT_READ_ONLY_TEXT: Record<NotReadOnly, string> = {
  syntax: '読める構文だけで書かれていない（変数・バッククォート・ファイルへのリダイレクト・ヒアドキュメント・代入・構文の語など）',
  command: '読むだけと分かっているコマンドでない',
  flag: '読むだけと分かっているコマンドだが、知らないフラグ・引数の形',
  path: '読む先・行き先が cwd の外か、読めない形',
  secret: '秘密が入っていそうなファイル（.env・鍵・トークンの類）を読む形',
  opaque: 'コマンド置換の結果を、echo 以外に渡している',
}

class Refused extends Error {
  readonly kind: NotReadOnly
  constructor(kind: NotReadOnly) {
    super(kind)
    this.kind = kind
  }
}
const refuse = (kind: NotReadOnly): never => {
  throw new Refused(kind)
}

/** 語 1 つ。`text` は引用符を外した字（`$( … )` の所は空）、`opaque` は `$( … )` を含む、`bare` は引用符の外の字だけでできている */
interface Word {
  text: string
  opaque: boolean
  bare: boolean
  /** 引用符の外にグロブの字（`*` `?` `[`）がある（シェルがファイルの名前に展開する） */
  glob: boolean
  /** 引用符の外の `~` で始まる（シェルがホームに展開する） */
  tilde: boolean
  /** 二重引用符の外に `$( … )` がある（bash は結果を空白で割り、グロブとして展開する） */
  loose: boolean
  /** 引用符の外に `^` か、頭でない `~` がある（zsh の拡張グロブ。`extendedglob` が入っていると `^README.md` はほかの全部のファイルに展開される） */
  xglob: boolean
}

/** いまの場所（`cd` で変わる）と、出てはいけない根 */
interface Place {
  dir: string
  root: string
}

/** 引用符の外で、語の字として受けるもの。これ以外（`{` `}` `\` `` ` `` `$` `!` 非 ASCII 制御文字…）は読めない */
const PLAIN = /[A-Za-z0-9_@%+=:,./^~*?[\]-]/
/** 捨てるだけのリダイレクト。ファイルへ書くもの・読むもの・ヒアドキュメントは受けない */
const HARMLESS_REDIRECT = /^(?:2>&1|[12]?>>? ?\/dev\/null|&> ?\/dev\/null)(?=[\s;|&)]|$)/

// ---- コマンドごとの「知っている形」

/**
 * 中身の分かる語の字。**シェルが展開する語（グロブ・`~`）は受けない**: `grep -v .e*` は `.env` に、`rg ~/.ssh/id_*` は鍵に展開されてから
 * コマンドに渡る（パターンのつもりの語が読む先になる）。グロブの結果が `-o` のようなフラグになることもある。引用符で囲めば字のまま
 */
const lit = (w: Word | undefined): string => {
  if (!w) return refuse('flag')
  if (w.opaque) return refuse('opaque')
  if (w.glob || w.tilde || w.xglob) return refuse('path')
  return w.text
}
/** git の語。リビジョンの `HEAD^`・`HEAD~2` は受ける（git が読むのは追跡しているものだけなので、展開されても読む先は広がらない） */
const gitLit = (w: Word | undefined): string => (w && !w.opaque && !w.glob && !w.tilde && !(w.xglob && w.bare && w.text.startsWith('^')) ? w.text : lit(w))

/** 読む先のパス。cwd の中で、秘密のファイルでないこと。`glob` はグロブを受けるか（中身を出すコマンドでは受けない） */
function readPath(w: Word, place: Place, glob = false): string {
  // 名前を並べるだけのコマンド（`ls`）だけ、グロブを受ける
  const text = glob && w.glob && !w.opaque && !w.tilde && !w.xglob ? w.text : lit(w)
  if (!place.root || !text || text.startsWith('~') || text.startsWith('-')) return refuse('path')
  // 名前の字は ASCII だけ（大文字小文字を区別しないファイルシステムは、`ſecrets.yml` を `secrets.yml` として開く）
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(text)) return refuse('path')
  // `.` で始まるグロブ（`ls .*`・`ls .?`）は、古い bash では `..` にも当たる
  if (w.glob && text.split('/').some((seg) => /^\.[.*?[]/.test(seg))) return refuse('path')
  // `..` はどこにあっても受けない（`link/../x` は、`link` が外へのシンボリックリンクなら外を読む）
  if (text.split('/').includes('..')) return refuse('path')
  const abs = normalize(text.startsWith('/') ? text : `${place.dir}/${text}`)
  if (!within(abs, place.root)) return refuse('path')
  // 秘密の判定は、cwd より上の階層の名前では掛けない（`~/work/secrets-app/` の中の普通のファイルを断らない）。
  // cwd の中は**階層ごとに**名前を見る（`secrets/db.yml`・`.envs/prod`・`.env/..namedfork/data` は、最後の名前だけでは分からない）
  const inside = abs.slice(place.root.length)
  if (isSecretPath(inside) || isSecretPath(text) || inside.split('/').some((seg) => seg && isSecretPath(seg))) return refuse('secret')
  return abs
}

interface FlagSpec {
  /** 値を取らないフラグ（まとめた短いフラグ `-la` は、全部の字がここにあること） */
  bare?: RegExp
  /** 次の語を値に取るフラグ → その値の検査（省略は「中身の分かる語なら何でも」） */
  value?: Record<string, (w: Word, place: Place) => void>
  /** `--name=value` の形で受けるフラグ → 値の検査 */
  eq?: Record<string, (v: string) => void>
}

const anyLiteral = (w: Word) => void lit(w)
const numeric = (w: Word) => void (/^\d+$/.test(lit(w)) || refuse('flag'))
const numberText = (v: string) => void (/^\d+$/.test(v) || refuse('flag'))
const anyText = () => {}

/** フラグを外した残りの語を返す。知らないフラグがあれば通さない。`--` のあとは全部ふつうの語 */
function takeFlags(args: readonly Word[], spec: FlagSpec, place: Place): Word[] {
  const rest: Word[] = []
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!
    if (w.opaque || !w.text.startsWith('-') || w.text === '-') {
      rest.push(w)
      continue
    }
    const text = lit(w)
    if (text === '--') {
      rest.push(...args.slice(i + 1))
      break
    }
    if (spec.value && Object.hasOwn(spec.value, text)) {
      const next = args[++i]
      if (!next) return refuse('flag')
      spec.value[text]!(next, place)
      continue
    }
    const eq = text.indexOf('=')
    if (eq > 0 && spec.eq && Object.hasOwn(spec.eq, text.slice(0, eq))) {
      spec.eq[text.slice(0, eq)]!(text.slice(eq + 1))
      continue
    }
    if (spec.bare?.test(text)) continue
    return refuse('flag')
  }
  return rest
}

/** `piped` は、パイプの 2 つ目以降か（前のコマンドの出力を読む）。読む先の無い形は、これが無いと標準入力を待って止まる */
type Check = (args: readonly Word[], place: Place, piped: boolean) => void

/** フラグを見て、残りを全部「読む先」として見る（中身を出すコマンド。グロブは受けない） */
const reads = (spec: FlagSpec, opts: { glob?: boolean; noStdin?: boolean } = {}): Check => (args, place, piped) => {
  const rest = takeFlags(args, spec, place)
  // 読む先が無ければ標準入力を読む。パイプの先頭でそれをすると止まる
  if (rest.length === 0 && !piped && !opts.noStdin) refuse('flag')
  for (const w of rest) readPath(w, place, opts.glob)
}

/** `grep`: 最初の語がパターン、残りが読む先。`-e` があれば全部が読む先。読む先が無ければ、パイプの出力を読む形だけ */
const grepCheck = (spec: FlagSpec): Check => (args, place, piped) => {
  let patterned = false
  const withE: FlagSpec = { ...spec, value: { ...spec.value, '-e': (w) => { anyLiteral(w); patterned = true } } }
  const rest = takeFlags(args, withE, place)
  const paths = patterned ? rest : rest.slice(1)
  if (!patterned) lit(rest[0])
  if (paths.length === 0 && !piped) refuse('flag')
  for (const w of paths) readPath(w, place)
}

/** `find`: 始点（cwd の中）と、名前・種類・深さで絞る述語だけ。`-exec`・`-delete`・`-fprint` の類は知らないので通さない */
const FIND_BARE = new Set(['-print', '-print0', '-not', '-o', '-or', '-a', '-and', '-empty', '-depth'])
const FIND_VALUE = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-type', '-maxdepth', '-mindepth', '-mtime', '-mmin', '-size', '-regex', '-iregex'])
const findCheck: Check = (args, place) => {
  let i = 0
  // 始点にグロブは受けない（`find * -name x` は、`-delete` という名前のファイルがあると述語として読まれる）
  for (; i < args.length && !args[i]!.opaque && !/^[-!(]/.test(args[i]!.text); i++) readPath(args[i]!, place)
  for (; i < args.length; i++) {
    const text = lit(args[i])
    if (FIND_BARE.has(text)) continue
    if (!FIND_VALUE.has(text)) return refuse('flag')
    const value = args[++i]
    if (!value) return refuse('flag')
    // 値は引用符で囲んだパターン（囲んでいないグロブはシェルが展開するので `lit()` が断る）
    lit(value)
  }
}

/** `sed`: `sed -n '10,20p' file` の形だけ（表示するだけの番地）。`-i`・`w`・`e` は知らないので通さない */
const sedCheck: Check = (args, place, piped) => {
  if (lit(args[0]) !== '-n') return refuse('flag')
  if (!/^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(lit(args[1]))) return refuse('flag')
  if (args.length === 2 && !piped) return refuse('flag')
  for (const w of args.slice(2)) readPath(w, place)
}

/**
 * `echo`: 中身の分からない語（`$( … )` の結果）も受ける。出すだけで、ファイルは開かない。
 * グロブと `~` は受けない（`echo ~/.ssh/*` は cwd の外の名前を並べる）。`printf` は入れない（`printf -v` は変数に書き、
 * bash では添字の中の式が実行される）
 */
const prints: Check = (args) => {
  for (const w of args) {
    if (w.glob || w.tilde || w.xglob) refuse('path')
    // `$( … )` は二重引用符の中だけ（`echo "$(…)"`）。外だと bash は結果をグロブとして展開する（`echo $(echo '/etc/*')` が名前を並べる）
    if (w.loose) refuse('opaque')
  }
}

/** 引数を取らないか、中身の分かる語だけを取る（ファイルは開かない） */
const literals = (spec: FlagSpec = {}, max = Infinity): Check => (args, place) => {
  const rest = takeFlags(args, spec, place)
  if (rest.length > max) refuse('flag')
  for (const w of rest) lit(w)
}

// ---- git / gh（読むサブコマンドだけ）

/**
 * git の読むサブコマンドで受けるフラグ。**知っているものだけ**（git は長いフラグの省略形を受けるので、拒否の一覧では
 * `--open-files-in-pag=…` のような省略を止められない。#754 のレビュー）。`--name` と `--name=value` の両方を受ける。
 * 書く・別のコマンドを走らせる・リポジトリの外や追跡外を読むフラグ（`--output`・`-O`・`--open-files-in-pager`・`--ext-diff`・
 * `--textconv`・`--no-index`・`--untracked`・`--no-exclude-standard`・`--contents`・`-f`）は入れない
 */
const GIT_LONG = new Set([
  'oneline', 'stat', 'shortstat', 'numstat', 'name-only', 'name-status', 'summary', 'format', 'pretty', 'abbrev-commit', 'abbrev', 'graph', 'decorate', 'no-decorate',
  'all', 'branches', 'tags', 'remotes', 'no-merges', 'merges', 'first-parent', 'since', 'until', 'after', 'before', 'author', 'committer', 'grep', 'follow', 'reverse',
  'max-count', 'skip', 'cached', 'staged', 'patch', 'no-patch', 'unified', 'color', 'no-color', 'word-diff', 'ignore-all-space', 'ignore-space-change', 'ignore-blank-lines',
  'short', 'porcelain', 'branch', 'show-toplevel', 'show-prefix', 'abbrev-ref', 'verify', 'quiet', 'count', 'left-right', 'is-inside-work-tree', 'git-common-dir',
  'absolute-git-dir', 'show-current', 'diff-filter', 'date', 'always', 'dirty', 'contains', 'merged', 'no-merged', 'sort', 'points-at', 'others', 'exclude-standard',
  'modified', 'deleted', 'full-name', 'line-number', 'ignore-case', 'fixed-strings', 'extended-regexp', 'word-regexp', 'files-with-matches', 'heading', 'break',
  'no-renames', 'find-renames', 'cc', 'root', 'topo-order', 'date-order', 'no-walk', 'symbolic', 'symbolic-full-name', 'is-ancestor', 'octopus',
  'long', 'exact-match', 'pickaxe-all', 'stat-width', 'relative', 'no-prefix', 'minimal', 'histogram', 'patience', 'raw', 'check', 'exit-code', 'ignored', 'null',
])
/**
 * 短いフラグ。**値を取らない 1 字と、数字の付いた決まった形だけ**。まとめた形（`-pO`）・値を付けた形（`-Sx`・`-L1,5:f`・`-GOrm`）は受けない:
 * git はまとめた短いフラグを 1 字ずつ読むので、`git grep -GOrm` は `-G -Orm`（一致したファイルを `rm` に渡す）になる。#754 の 3 回目のレビュー
 */
const GIT_SHORT = /^-(?:[psqnwbrtvaz]|\d+|U\d+|n\d+)$/
const gitArgs = (args: readonly Word[]): string[] => {
  /** フラグでない語（リビジョン・パス・フラグの値） */
  const plain: string[] = []
  for (const w of args) {
    const text = gitLit(w)
    // 署名を確かめる書式（`%G?`・`%GS`・`%(signature)`）は `gpg` / `ssh-keygen` を起こす（どれを起こすかはコミットの中身で決まる）
    if (/%G|%\(signature/.test(text)) refuse('flag')
    if (text === '--') {
      plain.push(text)
      continue
    }
    if (text.startsWith('--')) {
      const eq = text.indexOf('=')
      if (!GIT_LONG.has(text.slice(2, eq < 0 ? undefined : eq))) refuse('flag')
      continue
    }
    if (text.startsWith('-')) {
      if (!GIT_SHORT.test(text)) refuse('flag')
      continue
    }
    // フラグでない語（リビジョン・パス・フラグの値）: リポジトリの外を指す形（`git diff /etc/a /etc/b` は外のファイルを読む）と、
    // 秘密のファイルの名前（`HEAD:.env`・`-- .env`）は受けない
    // グロブの字を含む語（引用符で囲んだ pathspec `'.en*'`）も受けない: 名前で秘密と見分けられない
    if (text.startsWith('/') || text.split(/[/:]/).includes('..') || /[*?[]/.test(text)) refuse('path')
    // 名前の字は ASCII だけ（大文字小文字を区別しないファイルシステムは、`ſecrets.yml` を `secrets.yml` として開く）
    // eslint-disable-next-line no-control-regex
    if (/[^\x20-\x7e]/.test(text)) refuse('path')
    if (text.slice(text.lastIndexOf(':') + 1).split('/').some((seg) => seg && isSecretPath(seg))) refuse('secret')
    plain.push(text)
  }
  return plain
}
/** 引数が何でも読むだけの git のサブコマンド */
const GIT_READS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'cat-file', 'merge-base', 'describe', 'blame', 'name-rev', 'for-each-ref', 'show-ref', 'count-objects', 'diff-tree'])
/** 引数によっては書くサブコマンド → 読むだけの形 */
const GIT_LISTS: Record<string, RegExp> = {
  branch: /^(?:-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--verbose|--no-color|--contains(?:=.*)?|--merged(?:=.*)?|--no-merged(?:=.*)?|--format=.*|--sort=.*)$/,
  tag: /^(?:-l|--list|-n\d*|--contains(?:=.*)?|--sort=.*|--format=.*)$/,
  // `git remote -v` は URL を出す（`https://user:token@…` の形で鍵が入っていることがある）。名前だけの形を受ける
  remote: /^$/,
  stash: /^list$/,
  worktree: /^list$/,
  reflog: /^(?:show|-\d+|-n\d*|--format=.*|--date=.*)$/,
}
const gitCheck: Check = (args) => {
  // サブコマンドの前に受けるのは `--no-pager` だけ（`-C <dir>` は受けない: 下の階層に別のリポジトリがあれば、その設定で動く）
  const i = lit(args[0]) === '--no-pager' ? 1 : 0
  const sub = lit(args[i])
  // サブコマンドの前の、知らないフラグ（`-c`・`-p`・`--git-dir`・`--config-env` …）
  if (sub.startsWith('-')) return refuse('flag')
  const rest = args.slice(i + 1)
  if (GIT_READS.has(sub)) {
    const plain = gitArgs(rest)
    if (sub === 'diff') {
      // リポジトリの外では、パスを 2 つ渡した `git diff a b` が `diff -r`（ディレクトリの中のファイルの中身を全部出す）になる。
      // フラグでない語は 1 つまで。2 つ以上は `<リビジョン> -- <パス…>` の形だけ（頭がリビジョンと分かる語）
      const cut = plain.indexOf('--')
      const words = plain.filter((t) => t !== '--')
      if (words.length >= 2 && !(cut === 1 && /^HEAD\b|\.\.|[~^@]|^[0-9a-f]{7,40}$/.test(plain[0]!))) refuse('path')
    }
    return
  }
  const list = Object.hasOwn(GIT_LISTS, sub) ? GIT_LISTS[sub] : undefined
  if (!list) return refuse('command')
  // 一覧する形のフラグだけ。フラグでない語（ブランチの名前など）が来たら「作る・消す」かもしれないので通さない
  // （`stash list`・`worktree list`・`reflog show` は、その語そのものが形）
  for (const w of rest) if (!list.test(lit(w)) || /%G|%\(signature/.test(w.text)) refuse('flag')
  if ((sub === 'stash' || sub === 'worktree') && rest.length === 0) refuse('flag')
}

/** gh の読むサブコマンド（`gh pr view`）。`api` は下で別に見る */
const GH_READS: Record<string, Set<string>> = {
  pr: new Set(['view', 'list', 'status', 'checks', 'diff']),
  issue: new Set(['view', 'list', 'status']),
  repo: new Set(['view']),
  run: new Set(['view', 'list']),
  release: new Set(['view', 'list']),
  workflow: new Set(['view', 'list']),
  label: new Set(['list']),
}
/**
 * gh の読むサブコマンドで受けるフラグ。**知っているものだけ・1 語ずつ**（まとめた短いフラグ `-cw`・値を付けた短いフラグ `-qenv` は受けない。
 * 知らないフラグを 1 つでも受けると、gh は「その次の語」を値として読み飛ばすので、`gh pr --body view merge 5` が `pr merge` になる。#754 のレビュー）
 */
const GH_BARE = new Set(['--comments', '--paginate', '--name-only', '--patch', '--required'])
/** `--jq` / `-q` / `--template` は入れない（jq の式は環境変数を出せて、終わらない式も書ける。式の中身を読み切れない） */
const GH_VALUE = new Set(['--json', '--limit', '-L', '--state', '-s', '--search', '-S', '--author', '-A', '--assignee', '--label', '-l', '--base', '-B', '--head', '-H', '--branch', '-b', '--workflow', '--user', '--event', '--status', '--commit', '--milestone'])
const GH_REPO = /^[\w.-]+\/[\w.-]+$/
/** `gh api` で読む先。GET だけ（メソッド・フィールド・入力・ヘッダのフラグは、受けるフラグに無いので通らない） */
const GH_API_PATH = /^\/?(?:repos|users|orgs|rate_limit)(?:\/(?!\.\.?(?:\/|\?|$))[\w.@%+=:,-]+)*(?:\?[\w.@%+=:,&-]*)?$/
const ghCheck: Check = (args) => {
  const words = args.map(lit)
  let i = 0
  // 形は `gh [-R owner/repo] <まとまり> <サブコマンド> …` だけ。まとまりとサブコマンドの間にフラグは受けない
  if (words[i] === '-R' || words[i] === '--repo') {
    if (!GH_REPO.test(words[i + 1] ?? '')) return refuse('flag')
    i += 2
  }
  const group = words[i] ?? ''
  const sub = words[i + 1] ?? ''
  const api = group === 'api'
  if (api) {
    if (!GH_API_PATH.test(sub)) return refuse('flag')
  } else if (!Object.hasOwn(GH_READS, group) || !GH_READS[group]!.has(sub)) return refuse('command')
  for (let k = i + 2; k < words.length; k++) {
    const text = words[k]!
    if (!text.startsWith('-')) {
      // フラグでない語（番号・ブランチ）。`gh api` は読む先 1 つだけ。URL や `host/owner/repo` は受けない（問い合わせる先のホストを選べる）
      if (api || text.includes('://') || text.includes('@') || text.split('/').length > 2) return refuse('flag')
      continue
    }
    const eq = text.startsWith('--') ? text.indexOf('=') : -1
    const name = eq < 0 ? text : text.slice(0, eq)
    if (api && name !== '--paginate') return refuse('flag')
    if (name === '-R' || name === '--repo') {
      if (!GH_REPO.test(eq < 0 ? (words[++k] ?? '') : text.slice(eq + 1))) return refuse('flag')
    } else if (GH_VALUE.has(name)) {
      // 値が `-` で始まるものは受けない（サブコマンドによって値を取る・取らないが違うフラグで、読み方が gh とずれない）
      const value = eq < 0 ? words[++k] : text.slice(eq + 1)
      if (value === undefined || value.startsWith('-')) return refuse('flag')
    } else if (!GH_BARE.has(text)) return refuse('flag')
  }
}

/**
 * 読むだけと分かっているコマンド。**ここに無い名前は通さない**（`env` / `printenv`・`rm`・シェル・インタプリタ・`curl`・`tmux`・`docker`・
 * `security`・パッケージのスクリプトは無い）。フラグも 1 つずつ受ける形を書く。迷うものは入れない
 */
const COMMANDS: Record<string, Check> = {
  echo: prints,
  pwd: literals({ bare: /^-[LP]$/ }, 0),
  true: literals({}, 0),
  false: literals({}, 0),
  // `date 0101…`（時計を合わせる形）は受けない。書式（`+%s`）だけ
  date: (args, place) => void takeFlags(args, { bare: /^-[uR]$/ }, place).forEach((w) => /^\+[\w%:./, -]*$/.test(lit(w)) || refuse('flag')),
  uname: literals({ bare: /^-[asnrvmp]+$/ }, 0),
  whoami: literals({}, 0),
  which: literals({ bare: /^-a$/ }),
  basename: literals({}, 2),
  dirname: literals({}),
  cat: reads({ bare: /^-[nbsveEtTAu]+$/ }),
  head: reads({ bare: /^-(?:\d+|[nc]\d+|q|v)$/, value: { '-n': numeric, '-c': numeric }, eq: { '--lines': numberText, '--bytes': numberText } }),
  tail: reads({ bare: /^-(?:\d+|[nc]\+?\d+|q|v|r)$/, value: { '-n': (w) => void (/^\+?\d+$/.test(lit(w)) || refuse('flag')), '-c': numeric }, eq: { '--lines': numberText, '--bytes': numberText } }),
  wc: reads({ bare: /^-[lwcmL]+$/ }),
  nl: reads({ bare: /^-b[at]$/ }),
  sort: reads({ bare: /^-[rnufhVbdigMs]+$/, value: { '-k': anyLiteral, '-t': anyLiteral } }),
  // `uniq in out` の 2 つ目は書き先なので、ファイルの引数は取らせない（パイプの出力を読む形だけ）
  uniq: (args, place, piped) => void ((piped && takeFlags(args, { bare: /^-[cdui]+$/ }, place).length === 0) || refuse('flag')),
  cut: reads({ bare: /^-s$|^-[dfc].+$/, value: { '-d': anyLiteral, '-f': anyLiteral, '-c': anyLiteral } }),
  tr: (args, place, piped) => void ((piped && takeFlags(args, { bare: /^-[dsc]+$/ }, place).map(lit).length <= 2) || refuse('flag')),
  ls: reads({ bare: /^-[1aAlhFGtrSRdpU]+$/, eq: { '--color': anyText } }, { glob: true, noStdin: true }),
  // `-r` / `-R`（下の全部を読む。`.env` も読む）と `-f`（パターンをファイルから）は受けない。`rg` は入れない
  // （下へ潜って、隠していない秘密らしい名前のファイル（`prod.env`・`credentials.json`）も読む。読む先を 1 つずつ確かめられない）
  grep: grepCheck({ bare: /^-[ivnlLcHhoEFwxsqIaz]+$|^-[ABCm]\d+$/, value: { '-A': numeric, '-B': numeric, '-C': numeric, '-m': numeric }, eq: { '--color': anyText } }),
  find: findCheck,
  sed: sedCheck,
  git: gitCheck,
  gh: ghCheck,
}

/** 読むだけと分かっているコマンドの名前（文書・テスト用） */
export const READ_ONLY_COMMANDS: readonly string[] = Object.keys(COMMANDS)

// ---- 読み取り（知っている構文だけ。知らない字に当たったらその場で通さない）

class Reader {
  private readonly text: string
  private i = 0
  private depth = 0

  constructor(text: string) {
    this.text = text
  }

  /** コマンドの並びを読む。`close` があれば `)` まで（サブシェル・コマンド置換の中） */
  list(place: Place, close: boolean): void {
    if (++this.depth > 12) refuse('syntax')
    /** いまのパイプラインに並んだコマンドの名前（2 つ目以降は、前の出力を読む） */
    let pipeline: string[] = []
    const endPipeline = () => {
      pipeline = []
    }
    let expectCommand = true
    for (;;) {
      this.blanks(expectCommand)
      const c = this.text[this.i]
      if (c === undefined) {
        if (close || (expectCommand && pipeline.length > 0)) refuse('syntax')
        endPipeline()
        break
      }
      if (c === ')') {
        if (!close || (expectCommand && pipeline.length > 0)) refuse('syntax')
        this.i++
        endPipeline()
        break
      }
      if (!expectCommand) {
        // コマンドのあとは区切りだけ
        if (c === '\n' || c === ';') {
          this.i++
          endPipeline()
        } else if (this.text.startsWith('&&', this.i) || this.text.startsWith('||', this.i)) {
          this.i += 2
          endPipeline()
        } else if (c === '|' && this.text[this.i + 1] !== '&') {
          this.i++
        } else refuse('syntax')
        expectCommand = true
        continue
      }
      if (c === '(') {
        // サブシェル。中の `cd` は外に効かないので、場所は写しを渡す
        this.i++
        this.list({ ...place }, true)
        pipeline.push('(')
      } else {
        pipeline.push(this.command(place, pipeline.length > 0))
      }
      expectCommand = false
    }
    this.depth--
  }

  /** 空白と行のコメントを読み飛ばす。`newlines` はコマンドの前（空行・コメントの行）だけ */
  private blanks(newlines: boolean): void {
    for (;;) {
      const c = this.text[this.i]
      if (c === ' ' || c === '\t' || (newlines && c === '\n')) this.i++
      else if (c === '#' && (this.i === 0 || /[ \t\n]/.test(this.text[this.i - 1]!))) {
        // コメントは、いちばん外の並びでだけ受ける（古い bash / zsh は、`$( … )` の閉じ括弧を探すときにコメントを見ない）
        if (this.depth > 1) refuse('syntax')
        // コメントは空白か行頭のあとの `#` だけ。行の終わりまで（改行は区切りとして残す）
        const end = this.text.indexOf('\n', this.i)
        this.i = end < 0 ? this.text.length : end
      } else break
    }
  }

  /** コマンド 1 つを読んで確かめる。名前を返す */
  private command(place: Place, piped: boolean): string {
    const words: Word[] = []
    for (;;) {
      this.blanks(false)
      const rest = this.text.slice(this.i, this.i + 16)
      const harmless = HARMLESS_REDIRECT.exec(rest)
      if (harmless) {
        this.i += harmless[0].length
        continue
      }
      const c = this.text[this.i]
      if (c === undefined || c === '\n' || c === ';' || c === '|' || c === '&' || c === ')') break
      words.push(this.word(place))
    }
    const first = words[0]
    // 名前は、引用符も展開もグロブもパスも無い素の語だけ（`'rm'`・`r{m,m}`・`/bin/rm`・`$(…)`・`=ls` を受けない）
    if (!first || !first.bare || first.opaque || first.glob || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(first.text)) return refuse('syntax')
    const name = first.text
    const args = words.slice(1)
    const check = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
    if (!check) return refuse('command')
    // `$( … )` の結果を受けてよいのは、出すだけのコマンドだけ
    if (check !== prints && args.some((w) => w.opaque)) return refuse('opaque')
    check(args, place, piped)
    return name
  }

  /** 語 1 つ。素の字・`'…'`・`"…"`・`$( … )` だけでできていること */
  private word(place: Place): Word {
    const start = this.i
    const w: Word = { text: '', opaque: false, bare: true, glob: false, tilde: this.text[start] === '~', xglob: false, loose: false }
    for (;;) {
      const c = this.text[this.i]
      if (c === undefined || c === ' ' || c === '\t' || c === '\n' || c === ';' || c === '|' || c === '&' || c === ')') break
      if (c === "'") {
        const end = this.text.indexOf("'", this.i + 1)
        if (end < 0) refuse('syntax')
        w.text += this.text.slice(this.i + 1, end)
        w.bare = false
        this.i = end + 1
      } else if (c === '"') {
        w.bare = false
        this.i++
        for (;;) {
          const d = this.text[this.i]
          if (d === undefined) refuse('syntax')
          if (d === '"') break
          if (d === '$') this.substitution(place, w)
          // バックスラッシュは、英数字の前（`printf "%s\n"` の `\n`）だけ受ける: シェルは 2 字ともそのまま渡す。
          // `\"` `\$` `\\` `` \` `` と行末のバックスラッシュは意味が変わるので読めない側
          else if (d === '\\' && /[A-Za-z0-9]/.test(this.text[this.i + 1] ?? '')) {
            w.text += d
            this.i++
          }
          // 二重引用符の中で意味を持つ残りの字（バックスラッシュ・バッククォート）は読めない側。`!` は対話でないシェルでは字のまま
          else if (d === '\\' || d === '`' || d === '\r') refuse('syntax')
          else {
            w.text += d
            this.i++
          }
        }
        this.i++
      } else if (c === '$') {
        this.substitution(place, w)
        w.loose = true
      } else if (PLAIN.test(c!)) {
        if (c === '*' || c === '?' || c === '[') w.glob = true
        if (c === '^' || (c === '~' && this.i > start)) w.xglob = true
        w.text += c
        this.i++
      } else refuse('syntax')
    }
    if (this.i === start) refuse('syntax')
    // `=cmd`（zsh の展開）は、素の語の頭で意味が変わる。代入（`X=1 cmd`）は、コマンドの名前の形でないので下で断られる
    if (this.text[start] === '=') refuse('syntax')
    return w
  }

  /** `$( … )` だけ受ける。`$X`・`${…}`・`$(( … ))`・`$'…'` は読めない側 */
  private substitution(place: Place, w: Word): void {
    if (this.text[this.i + 1] !== '(' || this.text[this.i + 2] === '(') refuse('syntax')
    this.i += 2
    // 中の `cd` は外に効かない
    this.list({ ...place }, true)
    w.opaque = true
    w.bare = false
  }

  done(): boolean {
    return this.i >= this.text.length
  }
}

/** Jev が見ているコマンドの長さ（`shared/jev.ts` の `jevState()` が切る長さ）。これより長いコマンドは、Jev が全部を見ていない */
export const READ_ONLY_MAX_CHARS = 1000

/**
 * 読むだけと分かっているコマンドか（#749）。そうなら空、違えば理由の種類。**分からないものは全部「違う」**。
 * `cwd` はセッションの行のもの（分からなければ、ファイルを読む形・`cd` は通さない）
 */
export function notReadOnly(command: string, cwd: string): NotReadOnly | '' {
  // 字の種類を先に絞る: タブ・改行以外の制御文字（`\r` も）は読めない側
  // eslint-disable-next-line no-control-regex
  if (!command.trim() || command.length > READ_ONLY_MAX_CHARS || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(command)) return 'syntax'
  const root = cwd ? normalize(cwd) : ''
  try {
    const reader = new Reader(command)
    reader.list({ dir: root, root }, false)
    return reader.done() ? '' : 'syntax'
  } catch (err) {
    if (err instanceof Refused) return err.kind
    return 'syntax'
  }
}
