// 差分の画面に出す、サブディレクトリの `.codex/` のファイル（#856）。追跡しているもの・追跡外・`.gitignore` 済みを git から読む
// （読むだけ。パス 1 つごとに名前まで。中身は読まない）。端末で開いている Codex には起動前の確かめが効かないので、ここが見える場所になる
import type { CodexConfigFile } from '../../shared/types.ts'
import type { Git } from './diff.ts'

/** ファイルを全部並べず、`.codex/` の下だけを git に探させる（`node_modules` の類を受け取らない） */
const CODEX_FILES = [':(glob)**/.codex/**', ':(glob)**/.codex'] // 後ろは `.codex` そのものがリンク・ファイルのとき

/** worktree の中のサブディレクトリの `.codex/` のファイル。一番上の `.codex/` は出さない。git が読めなければ投げる */
export async function subdirCodexFiles(git: Git, cwd: string): Promise<CodexConfigFile[]> {
  // 下の 3 つは実行した場所より下しか出さないので、worktree の一番上で読む
  const top = (await git.run(cwd, ['rev-parse', '--show-toplevel'])).trim()
  const list = async (state: CodexConfigFile['state'], flags: string[]): Promise<CodexConfigFile[]> =>
    (await git.run(top, ['ls-files', '-z', ...flags, '--', ...CODEX_FILES]))
      .split('\0')
      .filter((path) => path && path !== '.codex' && !path.startsWith('.codex/'))
      .map((path) => ({ path, state }))
  const found = await Promise.all([list('tracked', ['--cached']), list('untracked', ['--others', '--exclude-standard']), list('ignored', ['--others', '--ignored', '--exclude-standard'])])
  return found.flat().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
