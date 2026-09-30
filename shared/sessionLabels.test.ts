import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionSummary } from './types.ts'
import { labelCollisions, labelSuffixes, sameNameNote, sameNamed, withSuffix } from './sessionLabels.ts'

type S = Pick<SessionSummary, 'id' | 'title' | 'meta' | 'project' | 'repo' | 'start' | 'archived' | 'turns'>
const s = (id: string, over: Partial<S> = {}): S => ({ id, title: '題名', project: 'Naturalclar/sai', repo: 'main', start: '2026-09-02T10:00:00+09:00', turns: 1, ...over })

test('labelSuffixes: 重なりが無ければ空（いまの見た目を変えない）', () => {
  const list = [s('a@main', { meta: { name: 'A' } }), s('b@main', { meta: { name: 'B' } }), s('c@main', { title: '別の題名' })]
  assert.deepEqual(labelCollisions(list), [])
  assert.equal(labelSuffixes(list).size, 0)
})

test('labelSuffixes: 同じ project で同じ名前なら、両方に始まった日を付ける（実データの sai_main の 2 つ）', () => {
  const list = [
    s('a3d02362-aaaa@main', { meta: { name: 'sai_main' }, start: '2026-09-24T10:00:00+09:00' }),
    s('b09bb99a-bbbb@main', { meta: { name: 'sai_main' }, start: '2026-09-25T09:00:00+09:00' }),
  ]
  // 窓の中の start ではなく、本当の始まりを引いたもので付ける
  const real: Record<string, string> = { 'a3d02362-aaaa@main': '2026-09-02T10:00:00+09:00' }
  const suffixes = labelSuffixes(list, (id) => real[id] ?? '')
  assert.equal(suffixes.get('a3d02362-aaaa@main'), '9/2〜')
  assert.equal(suffixes.get('b09bb99a-bbbb@main'), '9/25〜')
})

test('labelSuffixes: 別の project なら同じ名前でも付けない。表示名が無ければ題名で見る', () => {
  assert.equal(labelSuffixes([s('a@x', { meta: { name: 'N' }, project: 'o/x' }), s('b@y', { meta: { name: 'N' }, project: 'o/y' })]).size, 0)
  const byTitle = labelSuffixes([s('a@main', { start: '2026-09-02T10:00:00+09:00' }), s('b@main', { start: '2026-09-03T10:00:00+09:00' })])
  assert.deepEqual([...byTitle.values()], ['9/2〜', '9/3〜'])
})

test('labelSuffixes: 始まった日も同じなら ID の頭（重ならない長さまで伸ばす）。日で分けられるものは日のまま', () => {
  const list = [
    s('a3d0aaaa@main', { meta: { name: 'N' } }),
    s('a3d0bbbb@main', { meta: { name: 'N' } }),
    s('ffff0000@main', { meta: { name: 'N' }, start: '2026-09-05T10:00:00+09:00' }),
  ]
  const suffixes = labelSuffixes(list)
  assert.equal(suffixes.get('a3d0aaaa@main'), 'a3d0a')
  assert.equal(suffixes.get('a3d0bbbb@main'), 'a3d0b')
  assert.equal(suffixes.get('ffff0000@main'), '9/5〜')
})

test('withSuffix: 添え字があるときだけ足す', () => {
  assert.equal(withSuffix('sai_main', { label_suffix: '9/2〜' }), 'sai_main（9/2〜）')
  assert.equal(withSuffix('sai_main', {}), 'sai_main')
  assert.equal(withSuffix('sai_main', null), 'sai_main')
})

test('sameNamed: 同じ project のアーカイブ済みでないほかのセッションに同じ表示名があれば返す（止めはしない）', () => {
  const me = s('me@main')
  const twin = s('twin@main', { meta: { name: 'sai_main' }, turns: 285 })
  const list = [me, twin, s('old@main', { meta: { name: 'old' }, archived: true }), s('other@x', { meta: { name: 'x' }, project: 'o/x' })]
  assert.equal(sameNamed(list, me, ' sai_main ')?.id, 'twin@main')
  assert.equal(sameNamed(list, me, 'old'), null, 'アーカイブ済みは数えない')
  assert.equal(sameNamed(list, me, 'x'), null, '別の project は数えない')
  assert.equal(sameNamed(list, twin, 'sai_main'), null, '自分は数えない')
  assert.equal(sameNamed(list, me, ''), null)
  assert.equal(sameNameNote(twin), '同じ名前のセッションがあります（9/2〜、285 ターン）。一覧・要対応では添え字で見分けます')
})

test('labelSuffixes: 同じセッションの別の worktree（`<sid>@main` / `<sid>@feat`）は ID の頭では分けられないので worktree を足す（#578 のレビュー）', () => {
  const list = [s('a3d02362-aaaa@main', { meta: { name: 'N' } }), s('a3d02362-aaaa@feat', { meta: { name: 'N' } })]
  const suffixes = labelSuffixes(list)
  assert.equal(suffixes.get('a3d02362-aaaa@main'), 'a3d0@main')
  assert.equal(suffixes.get('a3d02362-aaaa@feat'), 'a3d0@feat')
})
