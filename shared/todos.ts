// エージェント自身の段取り（#397）。OpenCode の `GET /session/<id>/todo` の応答を読むだけの純粋関数で、
// 取りに行くのは `server/reply/opencodeServer.ts`、出すのは `web/src/ProgressTodos.tsx`。
//
// 実機（1.18.30）で確かめた応答:
//
// ```json
// [{"content":"調べる","status":"completed","priority":"medium"},
//  {"content":"直す","status":"in_progress","priority":"medium"},
//  {"content":"確かめる","status":"pending","priority":"medium"}]
// ```
//
// - **`id` は無い**（並びがそのまま順番）。サーバの OpenAPI（`/doc`）でも `content` / `status` / `priority` の
//   3 つだけが必須で `additionalProperties: false`
// - `status` は `pending` / `in_progress` / `completed` / `cancelled`、`priority` は `high` / `medium` / `low`
// - **取れるのは OpenCode だけ**（Claude の TodoWrite は transcript にしか無く、Codex には同じ口が無い）
import type { SessionTodo } from './types.ts'

/** 済みと数える状態。`cancelled` は「やらないことにした」なので、済みにも残りにも数えない */
const DONE = 'completed'
const DROPPED = 'cancelled'

/** `GET /session/<id>/todo` の応答を、出てきた順のまま読む。読めなければ空 */
export function opencodeTodos(data: unknown): SessionTodo[] {
  if (!Array.isArray(data)) return []
  const out: SessionTodo[] = []
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const content = typeof o.content === 'string' ? o.content.trim() : ''
    if (!content) continue
    out.push({
      content,
      status: typeof o.status === 'string' ? o.status : '',
      priority: typeof o.priority === 'string' ? o.priority : '',
    })
  }
  return out
}

/** 段取りの進み（`2/3` の形）。`cancelled` は分母からも外す */
export function todoCounts(todos: readonly SessionTodo[]): { done: number; total: number } {
  const live = todos.filter((t) => t.status !== DROPPED)
  return { done: live.filter((t) => t.status === DONE).length, total: live.length }
}

/** いま動かしているもの（`in_progress`）。無ければ最初の未着手、それも無ければ null */
export function todoNow(todos: readonly SessionTodo[]): SessionTodo | null {
  return todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending') ?? null
}
