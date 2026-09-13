import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chipsLevel, usageChips } from './usageChips.ts'
import type { UsageWindow } from '../../shared/types.ts'

const five = (used: number): UsageWindow => ({ used_percent: used, window_minutes: 300, resets_at: 1789578000 })
const week = (used: number): UsageWindow => ({ used_percent: used, window_minutes: 10080, resets_at: 1789578000 })
const codex = (used: number) => ({ primary: five(used), at: '2026-09-13T16:00:00+09:00' })

test('usageChips: Claude が先、Codex が後（狭い画面で落とすのは Codex 側。#347）', () => {
  const parts = usageChips({ codex: codex(15), claude: { primary: five(36), at: '' } })
  assert.deepEqual(parts.map((p) => p.agent), ['claude', 'codex'])
  assert.deepEqual(parts.map((p) => p.percent), [36, 15])
  assert.deepEqual(parts.map((p) => p.week), [false, false])
})

test('usageChips: Claude の 5 時間の枠が無ければ週に落とし、週の印を付ける（#347 の主因）', () => {
  // 手元の usage-claude.json が seven_day だけだった日。前はここで Claude のチップごと消えていた
  const parts = usageChips({ codex: codex(15), claude: { secondary: week(36), at: '' } })
  assert.deepEqual(parts.map((p) => [p.agent, p.percent, p.week]), [['claude', 36, true], ['codex', 15, false]])
  // 5 時間があるときは週に落とさない（両方あっても 5 時間が勝つ）
  const both = usageChips({ claude: { primary: five(12), secondary: week(80), at: '' } })
  assert.deepEqual(both.map((p) => [p.percent, p.week]), [[12, false]])
})

test('usageChips: 割合が無くても上限中なら出す。どちらも無ければ出さない', () => {
  const limited = usageChips({ claude: { limited: { resets_at: 1789578000, kind: 'five_hour' }, at: '' } })
  assert.deepEqual(limited.map((p) => [p.percent, p.limited]), [[null, true]])
  // 上限中で週も取れていれば、割合を出したうえで上限中の印も付ける
  const both = usageChips({ claude: { secondary: week(99), limited: { resets_at: 1789578000, kind: 'five_hour' }, at: '' } })
  assert.deepEqual(both.map((p) => [p.percent, p.week, p.limited]), [[99, true, true]])
  assert.deepEqual(usageChips({ claude: { at: '' } }), [], '割合も上限中も無ければ Claude は出さない')
  assert.deepEqual(usageChips({}), [])
  assert.deepEqual(usageChips({ codex: codex(5) }).map((p) => p.agent), ['codex'], 'Claude が無ければ Codex だけ')
})

test('chipsLevel: 一番きつい枠に合わせる。割合の無いチップは色を決めない', () => {
  assert.equal(chipsLevel(usageChips({ codex: codex(15), claude: { primary: five(36), at: '' } })), 'ok')
  assert.equal(chipsLevel(usageChips({ codex: codex(15), claude: { primary: five(85), at: '' } })), 'warn')
  assert.equal(chipsLevel(usageChips({ codex: codex(96), claude: { primary: five(10), at: '' } })), 'high')
  assert.equal(chipsLevel(usageChips({ claude: { secondary: week(96), at: '' } })), 'high', '週でも色は付ける')
  assert.equal(chipsLevel(usageChips({ claude: { limited: { resets_at: 1, kind: '' }, at: '' } })), 'ok')
  assert.equal(chipsLevel([]), 'ok')
})
