// `workState()`（#795。worktree に作りかけがあるか）に答える git の偽物。テスト用（本物の git を起こさない）。
// createApp を立てるテストが、cwd ごとの状態を置いて使う
import type { Git } from './diff.ts'

/** 偽物の worktree の HEAD の SHA */
export const FAKE_HEAD = 'a'.repeat(40)

/** 偽物に置ける状態。`merged` は「squash マージ済みのブランチが残っているだけ」（`workState()` の答えは `clean`） */
export type FakeWork = 'none' | 'clean' | 'dirty' | 'ahead' | 'merged' | 'unknown'

/**
 * その状態の worktree として、`workState()` が呼ぶコマンドに答える。関係の無いコマンドは `undefined`（呼び出し側の偽物が続きを決める）。
 * base は `main` だけがある形（`origin/*` は無い）
 */
export function workAnswer(state: FakeWork, args: string[]): string | undefined {
  const key = args.join(' ')
  if (key === 'rev-parse --show-toplevel') {
    if (state === 'none') throw new Error('fatal: not a git repository (or any of the parent directories): .git')
    if (state === 'unknown') throw new Error('git exited 128')
    return '/fake/top\n'
  }
  // いまの HEAD（マージ済みの PR の head と突き合わせる）
  if (key === 'rev-parse HEAD') return `${FAKE_HEAD}\n`
  if (key === 'status --porcelain') return state === 'dirty' ? ' M src/a.ts\n' : ''
  if (args[0] === 'symbolic-ref') throw new Error('not set')
  if (args[0] === 'rev-parse' && args[1] === '--verify') {
    if (args[3] === 'main^{commit}') return 'abc\n'
    throw new Error('no such ref')
  }
  if (key === 'merge-base --is-ancestor HEAD main') {
    if (state === 'ahead' || state === 'merged') throw new Error('git exited 1')
    return ''
  }
  if (key === 'diff --numstat --no-renames main...HEAD') return state === 'ahead' || state === 'merged' ? '1\t0\tsrc/a.ts\n' : ''
  if (key === 'diff --numstat --no-renames main HEAD -- src/a.ts') return state === 'ahead' ? '1\t0\tsrc/a.ts\n' : ''
  return undefined
}

/** cwd ごとの状態で答える git。置いていない cwd は `fallback`（既定は git のリポジトリでない） */
export class FakeWorkGit implements Git {
  states = new Map<string, FakeWork>()
  fallback: FakeWork
  constructor(fallback: FakeWork = 'none') {
    this.fallback = fallback
  }
  async run(cwd: string, args: string[]): Promise<string> {
    const out = workAnswer(this.states.get(cwd) ?? this.fallback, args)
    if (out === undefined) throw new Error(`unused: ${args.join(' ')}`)
    return out
  }
}
