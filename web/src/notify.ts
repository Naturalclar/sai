// タブの外へ「あなたを待っています」を出すための組み立て（#231）。DOM に依存しないので notify.test.ts で回す。
//
// **何が待っているかは自分で決めない。** `todoItems()`（要対応の画面とサイドバーのバッジが使っているもの）を
// そのまま受け取る。判定が 2 か所に分かれると、バッジは 2 なのに通知は 1 のような食い違いが出る。
import type { TodoItem } from './todoItems.ts'

/** タブの題名の元。件数はこの前に付ける */
export const TITLE_BASE = 'SAI'

/**
 * タブの題名。**件数を先頭に置く**（タブが狭いと後ろから省略されるので、後ろに付けると真っ先に消える）。
 * 0 件なら今までどおり
 */
export function titleWith(count: number, suffix = ''): string {
  const base = suffix ? `${TITLE_BASE} · ${suffix}` : TITLE_BASE
  return count > 0 ? `(${count}) ${base}` : base
}

/**
 * 待ち 1 件の見分け。`since`（いつから待っているか）を混ぜるので、**同じセッションが答えたあとに
 * また待ちに入れば別物**として扱える。逆に待ち続けている間は同じ鍵なので鳴り続けない
 */
export function notifyKey(item: TodoItem): string {
  return `${item.kind}:${item.id}:${item.since}`
}

/** まだ知らせていない待ち。`seen` に無いものだけ */
export function appeared(seen: ReadonlySet<string>, items: readonly TodoItem[]): TodoItem[] {
  return items.filter((t) => !seen.has(notifyKey(t)))
}

/** 出す通知の中身 */
export interface NotifyPlan {
  title: string
  body: string
  /** 押したときの行き先 */
  hash: string
  /** 同じ tag の通知は積み上がらず置き換わる */
  tag: string
}

/** セッションの呼び名。一覧から消えていれば ID（TodoView と同じ順） */
function labelOf(item: TodoItem): string {
  const s = item.session
  return s ? s.meta?.name || s.title || s.id : item.id
}

/**
 * 新しく待ちに入ったものから通知を組み立てる。無ければ null。
 *
 * **2 件以上はまとめて 1 通**にする（返信が一斉に許可待ちになると通知が積み上がるため）。
 * 行き先は**どちらも要対応**（`#/todo`）にする: 答え待ちはその画面でそのまま答えられるし、
 * 端末待ちもそこから開ける。1 件だけ別の飛び先にすると、押した先が毎回変わって迷う
 */
export function notifyPlan(items: readonly TodoItem[]): NotifyPlan | null {
  if (items.length === 0) return null
  if (items.length === 1) {
    const item = items[0]!
    return {
      title: item.kind === 'answer' ? `答え待ち: ${labelOf(item)}` : `待機中: ${labelOf(item)}`,
      body: item.text,
      hash: '#/todo',
      tag: notifyKey(item),
    }
  }
  const answers = items.filter((t) => t.kind === 'answer').length
  return {
    title: `${items.length} 件があなたを待っています`,
    body: answers > 0 ? `うち ${answers} 件は答え待ち（SAI から答えられます）` : items.map(labelOf).join('、'),
    hash: '#/todo',
    tag: 'sai-todo',
  }
}
