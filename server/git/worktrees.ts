// 新しいセッションを始められる場所（#319）。記録にある cwd と、同じリポジトリの兄弟 worktree（`git worktree list`）。
//
// **始められるのは git の作業ツリーの中だけ**にする（前は「ディレクトリか」しか見ず、記録にある `/`・`/tmp`・
// Claude Code の scratchpad でも始められた）。**広げるのは「記録のあるリポジトリ」の worktree まで**で、
// 記録の無いリポジトリには広げない（#319 の決めたこと。同一オリジンの守りが破られたときに走りうる場所を増やしすぎない）。
// ブラウザからはパスを受けない: 兄弟 worktree は一覧で付けた鍵（`worktreeKey()`）で選び、始めるときに
// サーバが `git worktree list` を読み直して、その中にある鍵だけを通す
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { dirname, sep } from 'node:path'
import type { Git } from './diff.ts'

/** `git worktree list --porcelain` の 1 項目 */
export interface WorktreeEntry {
  path: string
  /** `refs/heads/` を落としたブランチ名。detached なら空 */
  branch: string
  /** bare clone の本体（作業ツリーではない） */
  bare: boolean
  /** git が「中身が消えた」とみなしているもの（ディレクトリが無い） */
  prunable: boolean
  /** `git worktree lock` されたもの（中身はあるので始められる） */
  locked: boolean
}

/**
 * `git worktree list --porcelain` を読む。項目は空行で区切られ、`worktree <path>` で始まる。
 * `bare` / `detached` / `locked [理由]` / `prunable [理由]` は値の有無に関わらず行があれば立つ
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = []
  let cur: WorktreeEntry | null = null
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), branch: '', bare: false, prunable: false, locked: false }
      out.push(cur)
      continue
    }
    if (!cur) continue
    const [word] = line.split(' ', 1)
    if (word === 'branch') cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    else if (word === 'bare') cur.bare = true
    else if (word === 'prunable') cur.prunable = true
    else if (word === 'locked') cur.locked = true
  }
  return out
}

/** 兄弟 worktree を選ぶ鍵。パスそのものは画面から送らせない（サーバが一覧を読み直して引き当てる） */
export function worktreeKey(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 16)
}

/** cwd がその作業ツリーの中か（同じか、下のディレクトリ）。どちらも realpath に揃えてから比べる */
export function insideTree(cwd: string, tree: string): boolean {
  return cwd === tree || cwd.startsWith(tree.endsWith(sep) ? tree : tree + sep)
}

/** 始められる worktree 1 つ。path は realpath に揃えたもの */
export interface UsableWorktree {
  path: string
  key: string
  branch: string
}

/**
 * 新しい worktree の置き場（#847。既存の worktree の隣）。形が分からなければ null で、作る口を出さない。
 * - bare 本体があり、その直下に worktree があるなら bare 本体の直下（`<repo>.git/<name>`。よそにある worktree は数えない）
 * - そうでなければ、全部の worktree が同じ親にあるときだけ、その親（普通の clone はその隣）
 */
export function worktreeParent(bare: string | null, trees: readonly string[]): string | null {
  if (bare && trees.some((t) => dirname(t) === bare)) return bare
  const parents = new Set(trees.map((t) => dirname(t)))
  const [only] = parents
  return parents.size === 1 && only !== undefined && only !== dirname(only) ? only : null
}

/** 一覧を覚えておく長さ（候補を出す GET 用。始めるときは覚えたものを使わず読み直す） */
export const WORKTREES_TTL_MS = 30_000

export class Worktrees {
  private readonly git: Git
  private readonly ttl: number
  private readonly now: () => number
  private readonly cache = new Map<string, { at: number; value: Promise<{ trees: UsableWorktree[]; parent: string | null } | null> }>()

  constructor(git: Git, ttl = WORKTREES_TTL_MS, now: () => number = Date.now) {
    this.git = git
    this.ttl = ttl
    this.now = now
  }

  /**
   * cwd の属するリポジトリの、始められる worktree（bare 本体・`prunable`・ディレクトリの無いものを除く）。
   * git が読めない（git の外・git が無い）なら null。`fresh` なら覚えたものを使わない（始めるとき）
   */
  usable(cwd: string, fresh = false): Promise<UsableWorktree[] | null> {
    return this.load(cwd, fresh).then((v) => v?.trees ?? null)
  }

  /** 新しい worktree の置き場（`worktreeParent()`）。git が読めなければ null */
  parent(cwd: string): Promise<string | null> {
    return this.load(cwd, false).then((v) => v?.parent ?? null)
  }

  /** 覚えたものを捨てる（worktree を作ったとき） */
  forget(): void {
    this.cache.clear()
  }

  private load(cwd: string, fresh: boolean): Promise<{ trees: UsableWorktree[]; parent: string | null } | null> {
    const hit = this.cache.get(cwd)
    if (!fresh && hit && this.now() - hit.at < this.ttl) return hit.value
    const value = this.read(cwd)
    this.cache.set(cwd, { at: this.now(), value })
    return value
  }

  private async read(cwd: string): Promise<{ trees: UsableWorktree[]; parent: string | null } | null> {
    let out: string
    try {
      out = await this.git.run(cwd, ['worktree', 'list', '--porcelain'])
    } catch {
      return null
    }
    const usable: UsableWorktree[] = []
    let bare: string | null = null
    for (const e of parseWorktreeList(out)) {
      if (e.bare) bare = await realpath(e.path).catch(() => null)
      if (e.bare || e.prunable) continue
      try {
        const path = await realpath(e.path)
        if (!(await stat(path)).isDirectory()) continue
        usable.push({ path, key: worktreeKey(path), branch: e.branch })
      } catch {
        // 消えた（prunable と書かれる前に消されたもの）
      }
    }
    return { trees: usable, parent: worktreeParent(bare, usable.map((t) => t.path)) }
  }
}

/** cwd（realpath に揃えたもの）が入っている作業ツリー。どれにも入っていなければ null（git の作業ツリーではない） */
export function treeOf(cwd: string, trees: readonly UsableWorktree[]): UsableWorktree | null {
  // 入れ子の worktree があれば深い方
  let best: UsableWorktree | null = null
  for (const t of trees) if (insideTree(cwd, t.path) && (!best || t.path.length > best.path.length)) best = t
  return best
}
