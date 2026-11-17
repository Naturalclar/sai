// PR の解説のペイン（#887）の URL を、並んでいる方の名前の書き方にそろえる（#897）。判定だけを純粋関数にして node:test で回す。
// 呼ぶのは App.tsx の effect。**route（描いたときの値）でなく、いまの `location.hash` を渡す**: ほかのペインにフォーカスを移した直後は
// `location.hash` が先に変わり、route は hashchange のあとで追いつくので、古い route で見ると移った先の URL を解説の URL で上書きする
import { prExplainHash } from '../../shared/prs.ts'
import { parseRoute } from './hooks.ts'
import { shownSpelling, type PaneLayout } from './paneLayout.ts'

/** いまの URL が PR の解説を指していて、同じ PR が書き方だけ違う形で並んでいれば、置き換える hash。それ以外は空 */
export function explainUrlFix(hash: string, layout: PaneLayout): string {
  const route = parseRoute(hash)
  if (route.name !== 'pr-explain') return ''
  const repo = shownSpelling(layout, { kind: 'pr-explain', repo: route.repo, number: route.number })
  return repo ? prExplainHash(repo, route.number) : ''
}
