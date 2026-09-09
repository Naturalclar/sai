import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterPalette, moveIndex, paletteHash, paletteItems } from './palette.ts'
import type { SessionSummary } from './types.ts'

function session(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'S1@dev',
    start: '2026-09-09T01:00:00+09:00',
    end: '2026-09-09T02:00:00+09:00',
    date: '2026-09-09',
    dates: ['2026-09-09'],
    agent: 'claude',
    agents: ['claude'],
    project: 'Naturalclar/sai',
    projects: ['Naturalclar/sai'],
    repo: 'dev-kanade',
    repos: ['dev-kanade'],
    branch: 'main',
    branches: ['main'],
    cwd: '/w',
    turns: 1,
    waiting: '',
    title: '題名',
    title_full: '題名',
    session_source: 'payload',
    sources: ['payload'],
    last_text: '',
    pane: '',
    pid: 0,
    last_turn: '',
    last_turn_ts: '',
    model: '',
    models: [],
    permission_mode: '',
    ...over,
  } as SessionSummary
}

test('paletteItems: 先頭はフィード。ラベルは表示名 → タイトル → (無題)', () => {
  const items = paletteItems([
    session({ id: 'A@dev', title: 'CI の整備' }),
    session({ id: 'B@dev', title: '無視される', meta: { name: '画像を添える' } }),
    session({ id: 'C@dev', title: '' }),
  ])
  assert.equal(items[0]?.kind, 'feed')
  assert.deepEqual(items.slice(1).map((i) => (i.kind === 'session' ? i.label : '')), ['CI の整備', '画像を添える', '(無題)'])
  // hint はリポジトリ名 / ブランチ（worktree 名ではない）
  assert.equal(items[1]?.kind === 'session' ? items[1].hint : '', 'sai / main')
  // アイコンとアーカイブは付いているときだけ
  const [, plain] = paletteItems([session({})])
  assert.equal(plain?.kind === 'session' ? plain.icon : 'x', undefined)
  assert.equal(plain?.kind === 'session' ? plain.archived : 'x', undefined)
  const [, marked] = paletteItems([session({ icon: '/i.png', archived: true })])
  assert.equal(marked?.kind === 'session' ? marked.icon : '', '/i.png')
  assert.equal(marked?.kind === 'session' ? marked.archived : false, true)
})

test('paletteItems: project が空なら repo（worktree 名）に落ちる', () => {
  const [, item] = paletteItems([session({ project: '', repo: 'dev-min', branch: '' })])
  assert.equal(item?.kind === 'session' ? item.hint : '', 'dev-min')
})

test('filterPalette: 空なら全部。語がすべて当たるものだけ残す', () => {
  const items = paletteItems([
    session({ id: 'A@dev-kanade', repo: 'dev-kanade', title: '画像を添える' }),
    session({ id: 'B@dev-min', repo: 'dev-min', project: 'Naturalclar/other', title: 'CI の整備' }),
  ])
  assert.equal(filterPalette(items, '').length, 3)
  assert.deepEqual(filterPalette(items, '画像').map((i) => i.kind), ['session'])
  // 複数語は AND
  assert.deepEqual(filterPalette(items, 'sai 画像').map((i) => (i.kind === 'session' ? i.id : '')), ['A@dev-kanade'])
  assert.deepEqual(filterPalette(items, 'sai CI'), [], 'other/CI は sai に当たらない')
  // 大文字小文字は無視。ID でも当たる
  assert.deepEqual(filterPalette(items, 'ci').map((i) => (i.kind === 'session' ? i.id : '')), ['B@dev-min'])
  assert.deepEqual(filterPalette(items, 'B@dev').map((i) => (i.kind === 'session' ? i.id : '')), ['B@dev-min'])
  // フィードは日本語でも英語でも当たる
  assert.deepEqual(filterPalette(items, 'feed').map((i) => i.kind), ['feed'])
  assert.deepEqual(filterPalette(items, 'フィード').map((i) => i.kind), ['feed'])
  assert.deepEqual(filterPalette(items, '  '), items, '空白だけは空と同じ')
})

test('paletteHash: フィードとセッションの行き先', () => {
  assert.equal(paletteHash({ kind: 'feed', label: 'フィード', hint: '' }), '#/feed')
  assert.equal(paletteHash({ kind: 'session', id: 'a b@c', label: '', hint: '' }), '#/s/a%20b%40c')
})

test('moveIndex: 端では止まる。候補が無ければ 0', () => {
  assert.equal(moveIndex(0, 3, 'next'), 1)
  assert.equal(moveIndex(2, 3, 'next'), 2)
  assert.equal(moveIndex(0, 3, 'prev'), 0)
  assert.equal(moveIndex(5, 3, 'prev'), 2, '候補が減っても範囲に収める')
  assert.equal(moveIndex(0, 0, 'next'), 0)
})
