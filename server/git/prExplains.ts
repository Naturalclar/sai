// PR の解説（#881）。利用者のスキル `/brief-pr` を SAI の新しいセッションとして回し、できた `brief.html` を鍵で配る。
//
// - **回すのは人が押したときだけ**（`POST /api/prs/<owner>/<repo>/<番号>/explain`）。一覧・詳細の GET・ポーリングでは回さない
// - スキルの出力は OS の一時フォルダの直下の `brief-pr-*/brief.html`（スキル同梱の `render.py` が作る）。拾ってよいのは
//   **その形のファイルだけ**（`briefHtmlIn()`。realpath で確かめ、リンクは辿らない）
// - 覚えるのは PR ごとに最後に回した 1 つ（`~/.agent-feed/pr-explains.json`）。派生データで、消しても記録は壊れない。
//   **パスは画面に渡さない**（渡すのは鍵だけ。配る口は鍵で引いてパスを確かめ直す）
// - 一時フォルダの中身は OS に任せる（消えていたら「もうありません」にして、作り直せるようにする）
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { PrExplain } from '../../shared/types.ts'

export const PR_EXPLAINS_FILE = 'pr-explains.json'
/** 覚える PR の数の上限。超えたら回した時刻の古いものから落とす */
export const PR_EXPLAINS_MAX = 200
/** 配る HTML の上限。`render.py` の出力は数百 KB までなので十分 */
export const PR_EXPLAIN_MAX_BYTES = 5 * 1024 * 1024
/**
 * 配る口の応答ヘッダ。**スクリプトを動かさない・同じオリジンとして扱わせない**（`sandbox`）、**外から何も読み込ませない**
 * （`default-src 'none'`。インラインの CSS と `data:` の画像だけ。スキルの `render.py` が HTML に書く CSP と同じかそれより狭い。
 * 中身の CSP には頼らない: 形が合えば `render.py` を通らないファイルでも拾うので。#882 のレビュー）、種類を推し量らせない、覚えさせない
 */
export const PR_EXPLAIN_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"
export const PR_EXPLAIN_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': PR_EXPLAIN_CSP,
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
} as const

/** スキルに渡す最初の指示。URL は SAI が `gh` で読んだ PR のもの（リクエストからは受けない） */
export function explainPrompt(url: string): string {
  return `/brief-pr ${url}`
}

/** 1 件の覚え。`path` はサーバの中だけ（画面には `key` を渡す） */
export interface PrExplainRecord {
  /** 回したセッションのエンティティ ID */
  session: string
  /** 回したときの PR の head */
  head_sha: string
  at: string
  /** 見つけた `brief.html` の realpath。まだなら空 */
  path: string
  /** 回し終えたが見つからなかった */
  missing?: boolean
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function explainRecordFrom(v: unknown): PrExplainRecord | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const session = str(o.session)
  const head_sha = str(o.head_sha)
  if (!session || !head_sha) return null
  return { session, head_sha, at: str(o.at), path: str(o.path), ...(o.missing === true ? { missing: true } : {}) }
}

/** 配る口の鍵（パスの sha1 の頭 16 桁）。パスそのものは URL に出さない */
export function explainKey(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 16)
}

const explainStoreKey = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`

/** 返答の本文から拾う形。`file://` のあとのパスで、`brief-pr-…/brief.html` で終わるもの */
const FILE_LINK = /file:\/\/(\/[^\s)<>"'`]*?\/brief-pr-[^\s/)<>"'`]+\/brief\.html)/g

/**
 * 返答の本文から `brief.html` を拾う。**OS の一時フォルダ（realpath）の直下の `brief-pr-` で始まるフォルダの
 * `brief.html` で、フォルダもファイルもシンボリックリンクでない普通のファイル**だけ。当たらなければ空。
 * 最後に出てきたものから見る（作り直したターンでは新しい方を取る）
 */
export async function briefHtmlIn(text: string, tmpRoot: string): Promise<string> {
  let root: string
  try {
    root = await realpath(tmpRoot)
  } catch {
    return ''
  }
  const found = [...text.matchAll(FILE_LINK)].map((m) => m[1] ?? '').reverse()
  for (const raw of found) {
    let path: string
    try {
      path = decodeURI(raw)
    } catch {
      continue
    }
    if (await briefHtmlOk(path, root)) return path
  }
  return ''
}

/**
 * そのパスが配ってよい `brief.html` か。拾うときと配るときの両方で通す（覚えた後に差し替えられていないか）。
 * 書かれたパスは `/var/…`（`/private/var` のリンク）のこともあるので、**フォルダの親だけ** realpath に揃えて比べ、
 * フォルダとファイルは lstat でリンクでないことを見る
 */
export async function briefHtmlOk(path: string, root: string): Promise<boolean> {
  if (basename(path) !== 'brief.html') return false
  const dir = dirname(path)
  if (!basename(dir).startsWith('brief-pr-')) return false
  try {
    if ((await realpath(dirname(dir))) !== root) return false
    const d = await lstat(dir)
    if (!d.isDirectory() || d.isSymbolicLink()) return false
    const f = await lstat(path)
    return f.isFile() && !f.isSymbolicLink() && f.size <= PR_EXPLAIN_MAX_BYTES
  } catch {
    return false
  }
}

/**
 * 画面に渡す状態。`running` は回している間、`ready` は開ける、`gone` は見つけたが一時フォルダから消えた、
 * `failed` は回し終えたのに見つからなかった。`stale` は回したときから PR の head が進んだ
 */
export function explainView(rec: PrExplainRecord, o: { running: boolean; exists: boolean; head: string }): PrExplain {
  const base = { session: rec.session, at: rec.at, stale: !!o.head && o.head !== rec.head_sha }
  if (o.running) return { ...base, state: 'running' }
  if (rec.path) return o.exists ? { ...base, state: 'ready', key: explainKey(rec.path) } : { ...base, state: 'gone' }
  return { ...base, state: rec.missing ? 'failed' : 'running' }
}

export class PrExplainStore {
  readonly path: string
  private entries: Map<string, PrExplainRecord> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.path = path
  }

  private async load(): Promise<Map<string, PrExplainRecord>> {
    if (this.entries) return this.entries
    const entries = new Map<string, PrExplainRecord>()
    try {
      const obj: unknown = JSON.parse(await readFile(this.path, 'utf-8'))
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [key, v] of Object.entries(obj)) {
          const rec = explainRecordFrom(v)
          if (rec) entries.set(key, rec)
        }
      }
    } catch {
      // 無い・壊れているなら空から
    }
    this.entries ??= entries
    return this.entries
  }

  async get(repo: string, number: number): Promise<PrExplainRecord | undefined> {
    return (await this.load()).get(explainStoreKey(repo, number))
  }

  /** 配る口の鍵から、見つけた `brief.html` のパスを引く。無ければ空 */
  async pathOf(key: string): Promise<string> {
    for (const rec of (await this.load()).values()) if (rec.path && explainKey(rec.path) === key) return rec.path
    return ''
  }

  async set(repo: string, number: number, rec: PrExplainRecord): Promise<void> {
    const entries = await this.load()
    const key = explainStoreKey(repo, number)
    entries.delete(key)
    entries.set(key, rec)
    if (entries.size > PR_EXPLAINS_MAX) {
      const old = [...entries].sort((a, b) => a[1].at.localeCompare(b[1].at)).slice(0, entries.size - PR_EXPLAINS_MAX)
      for (const [k] of old) entries.delete(k)
    }
    const job = this.writing.then(async () => {
      const tmp = `${this.path}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(Object.fromEntries(entries), null, 2) + '\n', 'utf-8')
      await rename(tmp, this.path)
    })
    this.writing = job.catch(() => {})
    await job
  }
}
