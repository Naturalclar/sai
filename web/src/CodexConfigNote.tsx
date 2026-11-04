import type { CodexConfigFile } from './api'

const STATE_LABEL: Record<CodexConfigFile['state'], string> = { tracked: '管理されている', untracked: '追跡外', ignored: '.gitignore 済み' }

interface Props {
  files: readonly CodexConfigFile[]
  /** 読めなかった。差分そのものは出す */
  unknown: boolean
}

/**
 * 差分の画面の、サブディレクトリの `.codex/` の印（#856）。Codex の動きを変える設定なので、追跡外・`.gitignore` 済みも出す。
 * 端末で開いている Codex には起動前の確かめが効かないので、ここが気づく場所になる。名前までで中身は出さない
 */
export function CodexConfigNote({ files, unknown }: Props) {
  if (!unknown && files.length === 0) return null
  return (
    <div className="diff-section codex-config">
      <div className="head">
        サブディレクトリの .codex/<span className="n">{unknown ? '読めませんでした' : files.length}</span>
      </div>
      <div className="why">{unknown ? 'サブディレクトリの .codex/ があるかを確かめられませんでした。' : 'そのディレクトリで動く Codex の設定になります。置いた覚えがなければ中身を確かめてください。'}</div>
      <ul>
        {files.map((f) => (
          <li key={f.path}>
            {f.path}
            <span className="state">{STATE_LABEL[f.state]}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
