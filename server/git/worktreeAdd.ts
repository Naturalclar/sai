// 新しい worktree を作る（#847）。**SAI が git に書くのはここだけ**で、`RealGit` の読むだけの allowlist には足さない。
// 起こすのは `git worktree add --no-track -b <名前> <パス> <base>` の 1 形だけ。パスと名前はリクエストから組まず、
// `from` の行の cwd と検査した名前から作る。`git fetch` は打たない（手元の base から切る）。消す口は作らない
import { spawn } from 'node:child_process'
import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isRemoteHost } from '../../shared/host.ts'
import type { SessionSummary, SiblingWorktree } from '../../shared/types.ts'
import { worktreeNameRefusal } from '../../shared/worktreeName.ts'
import { resolveBase, validBase } from './diff.ts'
import type { Git } from './diff.ts'
import { treeOf, worktreeKey } from './worktrees.ts'
import type { Worktrees } from './worktrees.ts'

/** 作るのを待つ上限。大きいリポジトリでも checkout はこの手前で終わる見込み */
export const WORKTREE_ADD_TIMEOUT_MS = 120_000

/** worktree を作る口。本物を組むのは `main.ts` だけで、`createApp` の既定は作らない */
export interface WorktreeAdder {
  add(cwd: string, name: string, path: string, base: string): Promise<void>
}

export class RealWorktreeAdder implements WorktreeAdder {
  private readonly bin: string
  private readonly timeoutMs: number
  /** 実行ファイルは既定でサーバの PATH の `git`（#288）。テストは偽物を渡す */
  constructor(bin: string = 'git', timeoutMs: number = WORKTREE_ADD_TIMEOUT_MS) {
    this.bin = bin
    this.timeoutMs = timeoutMs
  }
  add(cwd: string, name: string, path: string, base: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // `--no-track`: base が `origin/main` でも、新しいブランチの上流を main にしない
      const child = spawn(this.bin, ['-C', cwd, '--no-pager', 'worktree', 'add', '--quiet', '--no-track', '-b', name, path, base], { stdio: ['ignore', 'ignore', 'pipe'], timeout: this.timeoutMs })
      let err = ''
      child.stderr.on('data', (c: Buffer) => {
        if (err.length < 2000) err += c.toString()
      })
      child.once('error', reject)
      child.once('close', (code, signal) => (code === 0 ? resolve() : reject(new Error(err.trim() || (signal ? `git が時間切れで止まりました（${signal}）` : `git exited ${code}`)))))
    })
  }
}

export type AddWorktreeResult = { status: 201; worktree: SiblingWorktree } | { status: number; error: string }

export function createAddWorktree(deps: { git: Git; worktrees: Worktrees; adder: WorktreeAdder; selfHost: () => string }): (from: SessionSummary, name: string) => Promise<AddWorktreeResult> {
  /** いま作っているパス。同時に 2 本来たら 1 つだけ通す */
  const adding = new Set<string>()
  return async (from, name) => {
    const refusal = worktreeNameRefusal(name)
    if (refusal) return { status: 400, error: refusal }
    if (isRemoteHost(from.host, deps.selfHost())) return { status: 400, error: `別のマシン（${from.host}）のセッションなので、ここでは作れません` }
    let cwd: string
    try {
      cwd = await realpath(from.cwd)
      if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory')
    } catch {
      return { status: 400, error: `cwd が見つかりません: ${from.cwd || '(空)'}` }
    }
    const trees = await deps.worktrees.usable(cwd, true)
    if (!trees || !treeOf(cwd, trees)) return { status: 400, error: `git の作業ツリーではないので、ここでは作れません: ${from.cwd}` }
    const parent = await deps.worktrees.parent(cwd)
    if (!parent) return { status: 400, error: 'worktree の置き場が分からないリポジトリなので、作れません（端末で git worktree add してください）' }
    const path = join(parent, name)
    if (adding.has(path)) return { status: 409, error: 'その名前の worktree を作っているところです' }
    adding.add(path)
    try {
      // `repo` は worktree のディレクトリ名なので、別の場所の worktree とも名前を重ねない。macOS は大文字小文字を区別しない
      const taken = trees.some((t) => basename(t.path).toLowerCase() === name.toLowerCase())
      if (taken || (await occupied(path))) return { status: 409, error: `その名前はもうあります: ${name}` }
      if (await hasBranch(deps.git, cwd, name)) return { status: 409, error: `そのブランチはもうあります: ${name}` }
      const base = await resolveBase(deps.git, cwd).catch(() => '')
      if (!validBase(base)) return { status: 409, error: '切り出す元のブランチ（main など）が見つかりません' }
      let failure = ''
      try {
        await deps.adder.add(cwd, name, path, base)
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err)
      }
      deps.worktrees.forget()
      const real = await realpath(path).catch(() => path)
      if (failure) {
        // `post-checkout` フックの失敗など、git が非 0 でも worktree はできていることがある。一覧にあれば使える
        const made = (await deps.worktrees.usable(cwd, true))?.some((t) => t.path === real)
        if (!made) {
          // checkout で落ちると、git はディレクトリを片付けるがブランチを残す。SAI は `worktree add` しか打たないので、消さずに人へ伝える
          const left = await hasBranch(deps.git, cwd, name)
          return { status: 500, error: `worktree を作れませんでした: ${failure}${left ? `（ブランチ ${name} が残っています。同じ名前で作り直すなら、端末で消してください）` : ''}` }
        }
      }
      return { status: 201, worktree: { from: from.id, worktree: worktreeKey(real), cwd: real, repo: basename(real), branch: name, project: from.project } }
    } finally {
      adding.delete(path)
    }
  }
}

const hasBranch = (git: Git, cwd: string, name: string): Promise<boolean> =>
  git.run(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`]).then(
    () => true,
    () => false,
  )

/** そのパスに何かあるか。読めなければ、ある扱い（作らない） */
const occupied = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    (err: NodeJS.ErrnoException) => err.code !== 'ENOENT',
  )
