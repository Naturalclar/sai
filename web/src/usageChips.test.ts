import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chipsLevel, claudeFreshness, codexFreshness, usageChips } from './usageChips.ts'
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

// #694: Claude の割合は端末の Claude Code が描いたときにしか届かない。古い値をいまの値と取り違えないようにする
const NOW = Date.parse('2026-10-06T14:00:00+09:00')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
// 時刻の言い換えは動かしているマシンの時間帯で出るので、期待も同じ時間帯で組む（CI は UTC）
const clock = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const dated = (iso: string) => `${new Date(iso).getMonth() + 1}/${new Date(iso).getDate()} ${clock(iso)}`

test('usageChips: 割合が 30 分より古ければ stale と「何時間前」を付ける（Claude は #694、Codex は #726）', () => {
  // 復帰時刻はまだ先の Codex
  const live = (used: number, at: string) => ({ primary: { ...five(used), resets_at: Math.floor(NOW / 1000) + 3600 }, at })
  const fresh = usageChips({ codex: live(15, ago(29 * 60_000)), claude: { secondary: week(37), at: ago(29 * 60_000) } }, NOW)
  assert.deepEqual(fresh.map((p) => [p.agent, p.stale, p.age]), [['claude', false, ''], ['codex', false, '']])
  const stale = usageChips({ codex: live(15, ago(31 * 60_000)), claude: { secondary: week(37), at: ago(27 * 3_600_000) } }, NOW)
  assert.deepEqual(stale.map((p) => [p.agent, p.percent, p.stale, p.age]), [['claude', 37, true, '27時間前'], ['codex', 15, true, '31分前']])
  // 色は割合のまま決める（古い 96% を緑にはしない）
  assert.equal(chipsLevel(usageChips({ claude: { primary: five(96), at: ago(3_600_000) } }, NOW)), 'high')
  // いつの値か分からない・now を渡さない（今までの呼び方）なら古いと言わない
  assert.deepEqual(usageChips({ claude: { secondary: week(37), at: '' } }, NOW).map((p) => p.stale), [false])
  assert.deepEqual(usageChips({ claude: { secondary: week(37), at: ago(27 * 3_600_000) } }).map((p) => p.stale), [false])
})

test('claudeFreshness: いつの値か（今日でなければ日付も）・古いか・5 時間が欠けているか（#694）', () => {
  // 実測の形: 10/5 10:57 に週だけ届いたまま、27 時間たっている
  const real = claudeFreshness({ secondary: week(37), at: '2026-10-05T10:57:58+09:00' }, NOW)
  assert.deepEqual(real, { at: `${dated('2026-10-05T10:57:58+09:00')} 時点`, age: '27時間前', stale: true, fiveHourMissing: true })
  // 5 時間も来ていて新しい
  assert.deepEqual(claudeFreshness({ primary: five(12), secondary: week(47), at: ago(5 * 60_000) }, NOW), { at: `${clock(ago(5 * 60_000))} 時点`, age: '5分前', stale: false, fiveHourMissing: false })
  // 上限中だけ（割合が 1 つも無い）: `at` は transcript の行の時刻なので古いとは言わず、「5 時間が取れていません」も出さない（設定の案内のほうが出る）
  assert.deepEqual(claudeFreshness({ limited: { resets_at: 1789578000, kind: 'five_hour' }, at: ago(5 * 3_600_000) }, NOW), { at: `${clock(ago(5 * 3_600_000))} 時点`, age: '', stale: false, fiveHourMissing: false })
  assert.deepEqual(claudeFreshness(undefined, NOW), { at: '', age: '', stale: false, fiveHourMissing: false })
})

// ---- 復帰時刻を過ぎた Codex の枠（#726）
test('usageChips: 復帰時刻を過ぎた Codex の枠は割合を出さず waiting にする（0% にも、消しもしない）', () => {
  // 実測の形: 76% のまま、復帰時刻を 44 時間過ぎ、値は 47 時間前
  const old = { primary: { used_percent: 76, window_minutes: 300, resets_at: Math.floor(NOW / 1000) - 44 * 3600 }, at: ago(47 * 3_600_000) }
  const parts = usageChips({ codex: old }, NOW)
  assert.deepEqual(parts, [{ agent: 'codex', name: 'Codex', percent: null, week: false, limited: false, stale: false, age: '', waiting: true }])
  // 色には数えない（前の枠の 96% でヘッダを赤くしない）
  assert.equal(chipsLevel(usageChips({ codex: { ...old, primary: { ...old.primary, used_percent: 96 } } }, NOW)), 'ok')
  // now を渡さない呼び方では今までどおり
  assert.deepEqual(usageChips({ codex: old }).map((p) => [p.percent, p.waiting]), [[76, false]])
  // Claude の側は waiting にならない
  assert.deepEqual(usageChips({ claude: { primary: five(36), at: '' } }, NOW).map((p) => p.waiting), [false])
})

test('codexFreshness: いつの値か・古いか・復帰時刻を過ぎたか（#726）', () => {
  const at = ago(47 * 3_600_000)
  const old = { primary: { used_percent: 76, window_minutes: 300, resets_at: Math.floor(NOW / 1000) - 44 * 3600 }, at }
  assert.deepEqual(codexFreshness(old, NOW), { at: `${dated(at)} 時点`, age: '47時間前', stale: true, waiting: true })
  const live = { primary: { used_percent: 20, window_minutes: 300, resets_at: Math.floor(NOW / 1000) + 600 }, at: ago(60_000) }
  assert.deepEqual(codexFreshness(live, NOW).stale, false)
  assert.deepEqual(codexFreshness(live, NOW).waiting, false)
  assert.deepEqual(codexFreshness(undefined, NOW), { at: '', age: '', stale: false, waiting: false })
})
