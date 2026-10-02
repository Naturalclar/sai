// 返答に出てきた手元のファイルを SAI で読む（#603）。サーバ（server/local/files.ts が配る）と画面（web/src/CodeSpan.tsx が押せるようにする）が
// 同じ見方・同じ鍵を使うためのもの。依存ゼロ・DOM 非依存なので node:test で回す（shared/files.test.ts）。
//
// 拾うのは返答の中の `` `コード` `` で、**中身がまるごとファイルのパスの形**のものだけ（`server/app.ts`・`docs/screen.md:12`）。
// 画像は #321 の口（shared/images.ts）が別にある。
import { imageKey } from './images.ts'
import { parseMarkdown } from './markdown.ts'
import type { Inline } from './markdown.ts'

/** `GET /api/sessions/<id>/files/<key>` の区切り。id は `/` を含まないので、最初の `/files/` が区切り */
export const FILES_SEGMENT = '/files/'

/** 配るファイルの上限。読むのはソースや文書なので 1MB（このリポジトリで一番大きい `server/app.ts` が入る大きさ） */
export const FILE_MAX_BYTES = 1024 * 1024

/**
 * パスとして拾う拡張子（文字のファイルのもの）。**一覧に無い拡張子は拾わない**: `` `session.turns` `` や `` `127.0.0.1:8787` `` の
 * ようなコードをファイルと取り違えないため。中身が本当に文字かはサーバが読んで確かめる
 */
const TEXT_EXT = new Set(
  ('ts tsx mts cts js jsx mjs cjs json jsonc json5 md mdx markdown txt log csv tsv py pyi rb go rs java kt kts swift c h cc cpp hpp cs php ' +
    'sh bash zsh fish ps1 sql graphql gql proto css scss sass less html htm xml svg vue svelte astro yml yaml toml ini cfg conf lock ' +
    'gradle tf hcl lua pl r dart ex exs erl hs ml scala clj el vim patch diff').split(' '),
)

/** パスに使わせない文字。空白・コロン（スキームと `path:行` の区切り）・ワイルドカード・引用符・山括弧・縦棒・バックスラッシュ・バッククォート */
const PATH_OK = /^[^\s:*?"'<>|\\`]+$/
/** 末尾の行の指定。`:12` / `:12:3`（桁）/ `:12-20`（範囲）/ `#L12` / `#L12-L20`。どれも**最初の行**だけ使う */
const LINE_SUFFIX = /(?::(\d+)(?:[:-]\d+)?|#L(\d+)(?:-L?\d+)?)$/

export interface FileRef {
  /** 本文に書かれたパスそのもの（行の指定は外したもの。絶対パスか、行の cwd からの相対パス） */
  path: string
  /** `path:行` の行。無ければ 0 */
  line: number
}

/** `` `コード` `` の中身がファイルのパスの形か。そうなら パスと行、違えば null */
export function fileRefOf(code: string): FileRef | null {
  const text = code.trim()
  if (!text || text.length > 400) return null
  const suffix = LINE_SUFFIX.exec(text)
  const path = suffix ? text.slice(0, suffix.index) : text
  const line = suffix ? Number(suffix[1] ?? suffix[2]) : 0
  if (!PATH_OK.test(path) || path.includes('//') || path.endsWith('/')) return null
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  // 拡張子の無い名前と、`.env` のように頭の `.` だけの名前は拾わない
  if (dot <= 0 || !TEXT_EXT.has(name.slice(dot + 1).toLowerCase())) return null
  return { path, line: Number.isSafeInteger(line) && line > 0 ? line : 0 }
}

/** 本文の中の `` `コード` `` から、ファイルのパスの形のものを出てきた順に、同じパスは 1 つにして返す。コードブロックの中は拾わない */
export function fileRefs(text: string): string[] {
  const found = new Set<string>()
  const walk = (nodes: Inline[]) => {
    for (const n of nodes) {
      if (n.kind === 'code') {
        const ref = fileRefOf(n.text)
        if (ref) found.add(ref.path)
      } else if (n.kind === 'strong' || n.kind === 'link') {
        walk(n.children)
      }
    }
  }
  for (const b of parseMarkdown(text)) {
    if (b.kind === 'paragraph' || b.kind === 'quote') b.lines.forEach(walk)
    else if (b.kind === 'heading') walk(b.children)
    else if (b.kind === 'list') for (const item of b.items) item.lines.forEach(walk)
    else if (b.kind === 'table') {
      b.head.forEach(walk)
      for (const row of b.rows) row.forEach(walk)
    }
  }
  return [...found]
}

/** 本文に書かれたパス → URL の鍵。画像（#321）と同じ作り（鍵は秘密ではなく、表に無い鍵は 404） */
export const fileKey = imageKey

/** 画面が読みに行く URL。**パスは載せない**（鍵だけ） */
export function sessionFileUrl(id: string, path: string): string {
  return `/api/sessions/${encodeURIComponent(id)}${FILES_SEGMENT}${fileKey(path)}`
}

/** 置き場の名前で断るもの（どの階層にあっても）。中は鍵や認証の設定（`.config/gh/hosts.yml`・`.config/gcloud/…` など） */
const SECRET_DIRS = new Set(['.git', '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.gcloud', '.config'])
/** ファイル名そのもので断るもの */
const SECRET_NAMES = new Set(['.npmrc', '.netrc', '.pypirc', '.htpasswd', '.pgpass', 'authorized_keys', 'known_hosts', '.claude.json', 'hosts.yml', 'hosts.yaml'])
/** 拡張子で断るもの（鍵・証明書の入れ物・Terraform の状態と変数・`prod.env` の形） */
const SECRET_EXT = new Set(['pem', 'key', 'p12', 'pfx', 'jks', 'keystore', 'kdbx', 'tfstate', 'tfvars', 'env'])
/** 名前のどこにあっても断る語（`.credentials.json`・`.secrets.yml`・`private_key.json`・`passwords.txt`） */
const SECRET_WORD = /credential|secret|passw(?:or)?d|private[_-]?key|service[_-]?account|api[_-]?key/
/** 設定・データのファイルのときだけ断る語（`token.json`・`auth.json`。`tokenizer.ts`・`auth.ts` のようなソースは読ませる） */
const SECRET_DATA_WORD = /token|auth/
const DATA_EXT = new Set(['json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'txt', 'xml', 'csv', 'lock'])

/**
 * **名前で断るファイル**（秘密が入っていそうなもの。#603 の決めること 1）。パスのどこかの階層が鍵の置き場、または
 * ファイル名が `.env*`・`*.env`・`id_*`・`*credential*`・`*secret*`・`*.pem`・`*.key`・`token.json`・`auth.json` などに当たれば true。
 * **中身は見ない**（読む前に断るためのもの）。大文字小文字は区別しない。
 * 名前だけで決めるので、すり抜ける名前は必ず残る（`settings.json` に鍵が書かれている、など）。そのために口はループバックだけにしてある
 */
export function isSecretPath(path: string): boolean {
  const parts = path.split(/[\\/]+/).filter(Boolean).map((p) => p.toLowerCase())
  const name = parts.at(-1) ?? ''
  if (parts.slice(0, -1).some((p) => SECRET_DIRS.has(p)) || SECRET_DIRS.has(name)) return true
  if (SECRET_NAMES.has(name)) return true
  if (name.startsWith('.env') || name.startsWith('id_')) return true
  if (SECRET_WORD.test(name)) return true
  const exts = name.split('.').slice(1)
  // `x.pem`・`x.key.json`・`terraform.tfstate.backup`・`prod.env` のように、途中にあっても断る
  if (exts.some((ext) => SECRET_EXT.has(ext))) return true
  return SECRET_DATA_WORD.test(name) && DATA_EXT.has(exts.at(-1) ?? '')
}
