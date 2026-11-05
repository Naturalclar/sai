import type { DotsMessage } from '../../shared/dots.ts'
import { Avatar } from './Avatar'
import { Markdown } from './Markdown'
import { hm } from './format'

/** dots の返答 1 つ（#872）。Markdown を React の要素として描く（HTML 文字列は作らない）。`orphan` は付く依頼が見つからなかった返答 */
export function DotsReply({ message: m, orphan = false }: { message: DotsMessage; orphan?: boolean }) {
  return (
    <div className="group dots-agent">
      <Avatar kind="dots" mark="D" />
      <div>
        <div className="gh">
          <span className="name">dots</span>
          <span className="time" title={m.at}>
            {hm(m.at)}
          </span>
          {orphan && <span className="dots-orphan">どの依頼への返答か分かりません</span>}
        </div>
        <div className="msg">
          <div className="body">
            <Markdown text={m.text} />
          </div>
        </div>
      </div>
    </div>
  )
}
