import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedRow } from '../../shared/types.ts'
import { groupRows, promptArrived, speakerLabel, toUtterances } from './chatGroups.ts'

// 時刻は Asia/Tokyo 固定のプロセスに依存しないよう、同じ日の中で分だけ動かす
const base = new Date('2026-09-02T03:00:00Z')
const at = (min: number) => new Date(base.getTime() + min * 60_000).toISOString()

function row(min: number, over: Partial<FeedRow> = {}): FeedRow {
  return { ts: at(min), agent: 'claude', repo: 'sai', branch: 'main', session: 's1', session_source: 'payload', cwd: '/x', event: 'Stop', text: '返答', ...over }
}

test('user_text があれば「自分」の発言が先に立ち、無ければエージェントの発言だけ', () => {
  const [mine, theirs] = toUtterances([row(0, { user_text: '頼み' })])
  assert.equal(mine?.speaker, 'me')
  assert.equal(mine?.text, '頼み')
  assert.equal(theirs?.speaker, 'claude')
  assert.equal(theirs?.text, '返答')

  const only = toUtterances([row(0), row(1, { user_text: '   ' })])
  assert.deepEqual(only.map((u) => u.speaker), ['claude', 'claude'])
})

test('同じ発言者が10分以内に続けば1つのグループ、10分空けば別のグループ', () => {
  const days = groupRows([row(0), row(9), row(19)])
  assert.equal(days.length, 1)
  const groups = days[0]!.groups
  assert.equal(groups.length, 2)
  assert.equal(groups[0]!.items.length, 2)
  assert.equal(groups[0]!.lastTs, at(9))
  assert.equal(groups[1]!.firstTs, at(19))
})

test('発言者かセッションが変わればグループを切る', () => {
  const days = groupRows([row(0, { user_text: '頼み' }), row(1), row(2, { session: 's2' })])
  const groups = days[0]!.groups
  assert.deepEqual(groups.map((g) => [g.speaker, g.session]), [['me', 's1'], ['claude', 's1'], ['claude', 's2']])
})

test('日付が変わったら日ごとの束を分け、グループも跨がない', () => {
  const days = groupRows([row(0), row(24 * 60)])
  assert.equal(days.length, 2)
  assert.notEqual(days[0]!.day, days[1]!.day)
  assert.equal(days[0]!.groups.length, 1)
  assert.equal(days[1]!.groups.length, 1)
})

test('待ちの行は待ちの発言になり、後に同じセッションの行が来ていれば resolved', () => {
  const wait = row(1, { event: 'PermissionRequest', text: '許可待ち: Bash: ls', user_text: '' })
  const open = toUtterances([row(0), wait])
  assert.equal(open.length, 2)
  assert.deepEqual([open[1]!.waiting, open[1]!.resolved, open[1]!.text, open[1]!.speaker], [true, false, '許可待ち: Bash: ls', 'claude'])

  const closed = toUtterances([row(0), wait, row(2)])
  assert.equal(closed[1]!.resolved, true)

  // 別セッションの行では解消しない
  const other = toUtterances([row(0), wait, row(2, { session: 's2' })])
  assert.equal(other[1]!.resolved, false)
})

test('入力の行（UserPromptSubmit + user_text）は自分の発言になり、続くターン完了の同じ入力は重ねない', () => {
  const prompt = row(0, { event: 'UserPromptSubmit', text: '', user_text: '頼み' })
  // 入力 → 返答。自分のバブルは入力の行の分だけ
  const us = toUtterances([prompt, row(1, { user_text: '頼み' })])
  assert.deepEqual(us.map((u) => [u.speaker, u.text]), [['me', '頼み'], ['claude', '返答']])
  assert.equal(us[0]!.row, prompt, '自分の発言は入力の行から')

  // 途中で待ちを挟んでも同じ
  const waited = toUtterances([prompt, row(1, { event: 'PermissionRequest', text: '許可待ち: Bash: ls', user_text: '' }), row(2, { user_text: '頼み' })])
  assert.deepEqual(waited.map((u) => u.speaker), ['me', 'claude', 'claude'])
  assert.equal(waited[1]!.resolved, true)

  // ターン完了の入力が違えば（端末で別の指示を打った）それは出す
  const differ = toUtterances([prompt, row(1, { user_text: '別の指示' })])
  assert.deepEqual(differ.map((u) => [u.speaker, u.text]), [['me', '頼み'], ['me', '別の指示'], ['claude', '返答']])

  // 一度重ねなかったら忘れる。次のターンの同じ入力は出す（入力の行が無かった = フック未設定）
  const again = toUtterances([prompt, row(1, { user_text: '頼み' }), row(2, { user_text: '頼み' })])
  assert.deepEqual(again.map((u) => u.speaker), ['me', 'claude', 'me', 'claude'])

  // 別セッションの入力の行は関係ない
  const other = toUtterances([row(0, { event: 'UserPromptSubmit', text: '', user_text: '頼み', session: 's2' }), row(1, { user_text: '頼み' })])
  assert.deepEqual(other.map((u) => [u.speaker, u.row.session]), [['me', 's2'], ['me', 's1'], ['claude', 's1']])
})

test('合図だけの再開の行（user_text 無し）はバブルにしないが、待ちの解消にはなる', () => {
  const us = toUtterances([row(0, { event: 'PermissionRequest', text: '許可待ち: Bash: ls', user_text: '' }), row(1, { event: 'UserPromptSubmit', text: '', user_text: '' })])
  assert.equal(us.length, 1)
  assert.equal(us[0]!.resolved, true)
  const days = groupRows([row(0), row(1, { event: 'UserPromptSubmit', text: '', user_text: '' })])
  assert.equal(days[0]!.groups[0]!.items.length, 1)
})

test('promptArrived: 送った返信と同じ入力の行が、送信時刻より後（1分の許容）に同じエンティティにあるか', () => {
  const since = at(10)
  const prompt = row(10, { event: 'UserPromptSubmit', text: '', user_text: ' 続きを ' })
  assert.equal(promptArrived([row(0), prompt], 's1@sai', '続きを', since), true)
  assert.equal(promptArrived([row(0), row(10, { event: 'UserPromptSubmit', text: '', user_text: '続きを', session: 's2' })], 's1@sai', '続きを', since), false, '別エンティティ')
  assert.equal(promptArrived([row(0), row(10, { user_text: '続きを' })], 's1@sai', '続きを', since), false, 'ターン完了の行では判定しない')
  assert.equal(promptArrived([row(0), prompt], 's1@sai', '違う文', since), false)
  assert.equal(promptArrived([row(0), row(5, { event: 'UserPromptSubmit', text: '', user_text: '続きを' })], 's1@sai', '続きを', since), false, '送信より前（許容を超える）')
  assert.equal(promptArrived([row(0), row(9.5, { event: 'UserPromptSubmit', text: '', user_text: '続きを' })], 's1@sai', '続きを', since), true, '30秒前は許容')
})

test('speakerLabel: 表示名・アイコン画像があればそれ、無ければエージェントの固定値。自分は固定', () => {
  assert.deepEqual(speakerLabel('claude', undefined), { name: 'Claude Code', mark: 'C' })
  assert.deepEqual(speakerLabel('codex', {}), { name: 'Codex CLI', mark: 'X' })
  assert.deepEqual(speakerLabel('unknown', undefined), { name: 'unknown', mark: '?' })
  assert.deepEqual(speakerLabel('claude', { meta: { name: '背中メニュー' }, icon: '/i/1' }), { name: '背中メニュー', mark: 'C', icon: '/i/1' })
  assert.deepEqual(speakerLabel('claude', { meta: { name: '背中メニュー' } }), { name: '背中メニュー', mark: 'C' }, '名前だけなら icon キーは無い（頭文字のまま）')
  assert.deepEqual(speakerLabel('claude', { icon: '/i/1' }), { name: 'Claude Code', mark: 'C', icon: '/i/1' })
  assert.deepEqual(speakerLabel('me', { meta: { name: '背中メニュー' }, icon: '/i/1' }), { name: 'あなた', mark: '私' }, '自分側はセッションの表示名・画像に引きずられない')
})
