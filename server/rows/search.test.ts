import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionSummary } from '../../shared/types.ts'
import { searchRows } from './search.ts'
import { row } from './aggregate.test.ts'

const at = (m: number) => new Date(Date.parse('2026-09-02T10:00:00Z') + m * 60_000)

/** 一覧の 1 件。名前とアイコンを添えるためだけに使う（足りないところは searchRows が行から埋める） */
function summary(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'S1@kanban',
    start: '',
    end: '',
    date: '',
    dates: [],
    agent: 'claude',
    agents: ['claude'],
    repo: 'kanban',
    repos: ['kanban'],
    project: 'Naturalclar/kanban',
    projects: [],
    remote: '',
    branch: 'main',
    branches: [],
    host: '',
    hosts: [],
    cwd: '',
    turns: 0,
    waiting: '',
    title: 'タイトル',
    title_full: '',
    session_source: 'payload',
    sources: [],
    last_text: '',
    model: '',
    models: [],
    permission_mode: '',
    pane: '',
    pid: 0,
    last_turn: '',
    ...over,
  }
}

test('searchRows: text（返答）と user_text（自分の入力）の両方に当たり、どちらかを who で分ける', () => {
  const rows = [row(at(0), 'S1', { text: 'squash マージしました', user_text: 'マージして' })]
  const agent = searchRows(rows, ['squash'], [])
  assert.deepEqual(agent.hits.map((h) => h.who), ['agent'])
  const me = searchRows(rows, ['マージして'], [])
  assert.deepEqual(me.hits.map((h) => h.who), ['me'])
  // 1 行で両方に当たれば 2 件（自分の入力が先）
  const both = searchRows(rows, ['マージ'], [])
  assert.deepEqual(both.hits.map((h) => h.who), ['me', 'agent'])
})

test('searchRows: 複数の語は AND', () => {
  const rows = [
    row(at(0), 'S1', { text: 'squash マージしました' }),
    row(at(1), 'S2', { text: 'rebase しました' }),
  ]
  assert.equal(searchRows(rows, ['squash', 'マージ'], []).hits.length, 1)
  assert.equal(searchRows(rows, ['squash', 'rebase'], []).hits.length, 0, '別の行に散っていても AND は当たらない')
})

test('searchRows: 待ちの行は舐めない（text が機械的な要約なので邪魔になる）', () => {
  const rows = [
    row(at(0), 'S1', { event: 'PermissionRequest', text: '許可待ち: Bash: rm -rf node_modules', user_text: '' }),
    row(at(1), 'S1', { event: 'Stop', text: '消しました', user_text: '' }),
  ]
  assert.equal(searchRows(rows, ['許可待ち'], []).hits.length, 0)
  assert.equal(searchRows(rows, ['消しました'], []).hits.length, 1, 'ターン完了の行は舐める')
})

test('searchRows: 待ちの行でも user_text には当たる（再開の行に自分の入力が載る）', () => {
  const rows = [row(at(0), 'S1', { event: 'UserPromptSubmit', text: '', user_text: '209に着手して' })]
  const found = searchRows(rows, ['209'], [])
  assert.deepEqual(found.hits.map((h) => h.who), ['me'])
})

test('searchRows: thinking は舐めない（言ったことではなく考えたこと）', () => {
  const rows = [row(at(0), 'S1', { text: 'できました', user_text: '', thinking: 'きーわーど を試そう' })]
  assert.equal(searchRows(rows, ['きーわーど'], []).hits.length, 0)
})

test('searchRows: 新しい順。上限に達したら truncated（古い方を落とす）', () => {
  const rows = [0, 1, 2, 3, 4].map((i) => row(at(i), 'S1', { text: `あたり ${i}`, user_text: '' }))
  const all = searchRows(rows, ['あたり'], [])
  assert.deepEqual(all.hits.map((h) => h.excerpt), ['あたり 4', 'あたり 3', 'あたり 2', 'あたり 1', 'あたり 0'])
  assert.equal(all.truncated, false)

  const capped = searchRows(rows, ['あたり'], [], 2)
  assert.deepEqual(capped.hits.map((h) => h.excerpt), ['あたり 4', 'あたり 3'], '新しい 2 件だけ')
  assert.equal(capped.truncated, true)
})

test('searchRows: 一覧にあれば表示名とアイコン、無ければ ID を label にする', () => {
  const rows = [row(at(0), 'S1', { text: 'あたり', user_text: '' })]
  const named = searchRows(rows, ['あたり'], [summary({ meta: { name: 'かなで' }, icon: '/icon.png' })])
  assert.equal(named.hits[0]!.label, 'かなで')
  assert.equal(named.hits[0]!.icon, '/icon.png')
  // hint は ⌘K のセッションの候補と同じ形（projectName が owner/ を落として短くする）
  assert.equal(named.hits[0]!.hint, 'kanban / main', 'リポジトリ / ブランチ')

  const bare = searchRows(rows, ['あたり'], [])
  assert.equal(bare.hits[0]!.label, 'S1@kanban', '一覧に無ければ ID')
  assert.equal(bare.hits[0]!.icon, undefined)
})

test('searchRows: アーカイブ済みも出す（探しているのは見失ったもの）。印は付ける', () => {
  const rows = [row(at(0), 'S1', { text: 'あたり', user_text: '' })]
  const found = searchRows(rows, ['あたり'], [summary({ archived: true })])
  assert.equal(found.hits.length, 1)
  assert.equal(found.hits[0]!.archived, true)
})

test('searchRows: 語が無ければ何も返さない（空の q で全件出さない）', () => {
  const rows = [row(at(0), 'S1', { text: 'なんでも' })]
  assert.deepEqual(searchRows(rows, [], []), { hits: [], truncated: false })
})

test('searchRows: 飛び先の ts は当たった行のもの', () => {
  const rows = [row(at(3), 'S1', { text: 'あたり', user_text: '' })]
  const found = searchRows(rows, ['あたり'], [])
  assert.equal(found.hits[0]!.ts, rows[0]!.ts)
  assert.equal(found.hits[0]!.id, 'S1@kanban')
})
