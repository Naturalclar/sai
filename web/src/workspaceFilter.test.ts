import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitHighlight } from '../../shared/search.ts'
import type { Workspace } from './newSession.ts'
import { filterWorkspaces } from './workspaceFilter.ts'

const w = (repo: string, over: Partial<Workspace> = {}): Workspace => ({
  key: `S@${repo}`,
  from: `S@${repo}`,
  cwd: `/Users/me/.ghq/github.com/Naturalclar/sai.git/${repo}`,
  project: 'Naturalclar/sai',
  repo,
  branch: 'main',
  end: '2026-09-25T10:00:00+09:00',
  ...over,
})

/** 強調された文字だけを抜き出す（どこが当たったかを読みやすく比べる） */
const marked = (text: string, hits: Parameters<typeof splitHighlight>[1]): string =>
  splitHighlight(text, hits)
    .filter((p) => p.hit)
    .map((p) => p.text)
    .join('|')

const froms = (list: ReturnType<typeof filterWorkspaces>) => list.map((m) => m.workspace.from)

test('何も打っていなければ全部を元の並び（新しい順）のまま、強調なしで返す', () => {
  const choices = [w('dev-mint'), w('dev-shell'), w('main')]
  for (const q of ['', '   ']) {
    const out = filterWorkspaces(choices, q)
    assert.deepEqual(froms(out), ['S@dev-mint', 'S@dev-shell', 'S@main'])
    assert.ok(out.every((m) => m.labelHits.length === 0 && m.cwdHits.length === 0))
  }
})

test('飛び飛びの文字でも当たる（saimin → Naturalclar/sai · dev-mint）。当たらないものは落とす', () => {
  const out = filterWorkspaces([w('dev-shell', { branch: 'feat' }), w('dev-mint')], 'saimin')
  assert.deepEqual(froms(out), ['S@dev-mint'])
  assert.equal(out[0]!.label, 'Naturalclar/sai · dev-mint（main）')
})

test('見出しと cwd をまたいでは当てない（長い cwd の文字を拾い集めて何にでも当たらないように）', () => {
  // 見出しは `sai`、cwd の /Users/me/.ghq/github.com/Naturalclar/… に m・i・n があるが、1 つの語は片方の中だけで当てる
  assert.deepEqual(froms(filterWorkspaces([w('dev-shell', { branch: 'feat' })], 'saimin')), [])
})

test('ブランチ名で飛び飛びに当たるものも出すが、worktree 名で詰まって当たる方が上', () => {
  // dev-shell は見出しの `sai` と `（main）` で当たる。dev-mint は `sai` と `dev-mint` で当たる
  const out = filterWorkspaces([w('dev-shell'), w('dev-mint')], 'saimin')
  assert.deepEqual(froms(out), ['S@dev-mint', 'S@dev-shell'])
})

test('大文字小文字は見ない', () => {
  assert.deepEqual(froms(filterWorkspaces([w('dev-mint')], 'DEVMIN')), ['S@dev-mint'])
  assert.deepEqual(froms(filterWorkspaces([w('Dev-Min')], 'devmin')), ['S@Dev-Min'])
})

test('続けて当たる方・語の頭で当たる方を上にする（同じ文字が入っていても散らばっている方は下）', () => {
  // どちらにも m・i・n は入っているが、`min` が続けて出てくるのは dev-mint だけ
  const out = filterWorkspaces([w('marine-kitchen'), w('dev-mint')], 'min')
  assert.deepEqual(froms(out), ['S@dev-mint', 'S@marine-kitchen'])
})

test('語の頭の文字で当たる方を上にする（dm → dev-mint の d・m は、admin の途中の dm より上）', () => {
  const out = filterWorkspaces([w('admin'), w('dev-mint')], 'dm')
  assert.deepEqual(froms(out), ['S@dev-mint', 'S@admin'])
})

test('同じくらいの当たり方なら元の並び（新しい順）を崩さない', () => {
  const out = filterWorkspaces([w('dev-b'), w('dev-a')], 'dev')
  assert.deepEqual(froms(out), ['S@dev-b', 'S@dev-a'])
})

test('空白で区切った語は全部当たるものだけ（AND）。語の順は問わない', () => {
  const choices = [w('dev-mint', { branch: 'issue-489' }), w('dev-mint2', { branch: 'main' })]
  assert.deepEqual(froms(filterWorkspaces(choices, '489 min')), ['S@dev-mint'])
  assert.deepEqual(froms(filterWorkspaces(choices, 'min 489')), ['S@dev-mint'])
  assert.deepEqual(froms(filterWorkspaces(choices, 'min zzz')), [])
})

test('ブランチと project にも当たる。見出しに無くても cwd で当たれば出して、強調は cwd の側に付ける', () => {
  const choices = [w('dev-mint', { branch: 'feat/fuzzy' }), w('work', { project: '', cwd: '/tmp/scratch/work', branch: '' })]
  const branch = filterWorkspaces(choices, 'fuzzy')
  assert.deepEqual(froms(branch), ['S@dev-mint'])
  assert.equal(marked(branch[0]!.label, branch[0]!.labelHits), 'fuzzy')

  const byCwd = filterWorkspaces(choices, 'scratch')
  assert.deepEqual(froms(byCwd), ['S@work'])
  assert.deepEqual(byCwd[0]!.labelHits, [], '見出しの `work` には当てない')
  assert.equal(marked(byCwd[0]!.workspace.cwd, byCwd[0]!.cwdHits), 'scratch')
})

test('強調は当たった文字だけ。続けて当たったところは 1 つにまとめる', () => {
  const [m] = filterWorkspaces([w('dev-mint')], 'devmin')
  assert.equal(marked(m!.label, m!.labelHits), 'dev|min')
  assert.deepEqual(m!.cwdHits, [])
})

test('同じ語が見出しにも cwd にもあれば、見出しの方で当てる', () => {
  const [m] = filterWorkspaces([w('dev-mint')], 'dev-mint')
  assert.equal(marked(m!.label, m!.labelHits), 'dev-mint')
  assert.deepEqual(m!.cwdHits, [])
})

test('サロゲートペアの文字があっても強調の場所がずれない', () => {
  const [m] = filterWorkspaces([w('🍣-bar')], 'bar')
  assert.equal(marked(m!.label, m!.labelHits), 'bar')
})
