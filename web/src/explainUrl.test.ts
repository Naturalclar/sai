import { test } from 'node:test'
import assert from 'node:assert/strict'
import { explainUrlFix } from './explainUrl.ts'
import type { PaneLayout } from './paneLayout.ts'

const layout: PaneLayout = { columns: [[{ kind: 'session', id: 'a' }], [{ kind: 'pr-explain', repo: 'Owner-A/Repo-A', number: 3 }]], focus: 0, keys: [0, 1] }

test('explainUrlFix: いまの URL が解説で、書き方だけ違う形で並んでいれば並んでいる方の書き方にする（#897）', () => {
  assert.equal(explainUrlFix('#/pr-explain/owner-a/repo-a/3', layout), '#/pr-explain/Owner-A/Repo-A/3')
  assert.equal(explainUrlFix('#/pr-explain/Owner-A/Repo-A/3', layout), '', '同じ書き方')
  assert.equal(explainUrlFix('#/pr-explain/owner-a/repo-a/4', layout), '', '並んでいない PR')
})

test('explainUrlFix: いまの URL がもう解説でなければ何もしない（フォーカスを移した直後に、移った先の URL を上書きしない）', () => {
  for (const hash of ['#/s/a', '#/feed', '#/todo', '#/pr/owner-a/repo-a/3', '']) assert.equal(explainUrlFix(hash, layout), '', hash)
})
