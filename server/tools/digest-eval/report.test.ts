// 一言の案を比べる道具の集計（#712）: 項目ごとの件数・長さ・事例ごとの勝ち負け・悪くなった項目の印・通す条件
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compare, lengthsOf, paired, report, totalsOf } from './report.ts'
import type { Sample } from './report.ts'
import type { ScoreCode } from './score.ts'

const s = (id: string, variant: string, codes: ScoreCode[] = [], over: Partial<Sample> = {}): Sample => ({ case: id, shape: 'done', variant, run: 1, summary: `一言-${id}-${variant}`, chars: 20, codes, ...over })

test('totalsOf: 項目ごとに「引っかかった出力の数」を数える。口が落ちた回は別に数える', () => {
  const t = totalsOf('a', [s('1', 'a'), s('2', 'a', ['too_long', 'too_long', 'invented_number']), s('3', 'a', [], { error: 'timeout' }), s('1', 'b', ['empty'])])
  assert.equal(t.samples, 2)
  assert.equal(t.errors, 1)
  assert.equal(t.clean, 1)
  assert.deepEqual(t.codes, { too_long: 1, invented_number: 1 })
  assert.equal(t.gates.invented_number, 1)
})

test('totalsOf: 同じことを両方の側から見た項目は、通す条件では 1 つに数える', () => {
  const t = totalsOf('a', [s('1', 'a', ['dropped_request', 'expect:request_dropped', 'expect:keep'])])
  assert.equal(t.gates.dropped_request, 1)
})

test('lengthsOf: 最小・中央・90%・最大と、目安を超えた数', () => {
  assert.deepEqual(lengthsOf([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]), { min: 10, median: 50, p90: 90, max: 100, over: 2 })
  assert.deepEqual(lengthsOf([]), { min: 0, median: 0, p90: 0, max: 0, over: 0 })
})

test('paired: 両方の案で一言が取れた組だけを残す', () => {
  const samples = [s('1', 'a'), s('1', 'b'), s('2', 'a'), s('2', 'b', [], { error: 'x' }), s('3', 'a', [], { run: 2 }), s('3', 'b')]
  assert.deepEqual(paired(samples, 'a', 'b').map((x) => `${x.case}${x.variant}`), ['1a', '1b'])
})

test('compare: 増えた項目を worse に入れ、通す条件の項目が増えたら通さない', () => {
  const samples = [s('1', 'a'), s('1', 'b', ['invented_number']), s('2', 'a', ['too_long']), s('2', 'b'), s('3', 'a'), s('3', 'b')]
  const c = compare(samples, 'a', 'b')
  assert.equal(c.pairs, 3)
  assert.deepEqual(c.diffs, { invented_number: 1, too_long: -1 })
  assert.deepEqual(c.worse, ['invented_number'])
  assert.equal(c.pass, false)
  assert.deepEqual(c.gates.filter((g) => g.failed).map((g) => g.id), ['invented_number'])
  assert.deepEqual(c.outcomes, [{ case: '1', winner: 'base' }, { case: '2', winner: 'candidate' }, { case: '3', winner: 'tie' }])
})

test('compare: 通す条件でない項目が増えただけなら通す（worse には出る）', () => {
  const c = compare([s('1', 'a'), s('1', 'b', ['too_long'])], 'a', 'b')
  assert.deepEqual(c.worse, ['too_long'])
  assert.equal(c.pass, true)
})

test('compare: 通す条件の項目は、事例の側の項目だけが増えても通さない', () => {
  for (const code of ['expect:number_extra', 'expect:request_dropped', 'expect:keep', 'expect:action_wrong'] as const) {
    assert.equal(compare([s('1', 'a'), s('1', 'b', [code])], 'a', 'b').pass, false, code)
  }
})

test('compare: 事例ごとの勝ち負けは、通す条件の項目を先に比べる', () => {
  // b は項目の数は少ないが、通す条件の項目に当たっている
  const c = compare([s('1', 'a', ['too_long', 'prefix']), s('1', 'b', ['action_swap'])], 'a', 'b')
  assert.deepEqual(c.outcomes, [{ case: '1', winner: 'base' }])
})

test('compare: 片方の口が落ちた組は比べず、数だけ出す', () => {
  const c = compare([s('1', 'a'), s('1', 'b'), s('2', 'a', ['invented_number']), s('2', 'b', [], { error: 'timeout' })], 'a', 'b')
  assert.equal(c.pairs, 1)
  assert.equal(c.unpaired, 1)
  assert.equal(c.base.gates.invented_number, 0)
})

test('report: 悪くなった項目に ▲ を付け、通す条件の結果を書く。本文と一言は出さない', () => {
  const samples = [s('1', 'a'), s('1', 'b', ['dropped_request']), s('2', 'a', ['too_long']), s('2', 'b')]
  const r = report({ samples, variants: ['a', 'b'], notes: ['作り物 2 件'] })
  const text = r.lines.join('\n')
  assert.equal(r.pass, false)
  assert.match(text, /通す条件: 満たしていない.*頼みが落ちた/)
  assert.match(text, /▲ 頼みが落ちた \| 0 \| 1 \| \+1/)
  assert.match(text, /▲ 頼みが落ちた `dropped_request`/)
  assert.match(text, /長さ超過 `too_long` \| 1 \| 0 \| -1/)
  assert.match(text, /b が良い 1・a が良い 1・同じ 0/)
  assert.match(text, /- 作り物 2 件/)
  assert.doesNotMatch(text, /一言-/)
})

test('report: 案が 1 つだけなら件数と長さだけで、通す', () => {
  const r = report({ samples: [s('1', 'a', ['too_long'])], variants: ['a'] })
  assert.equal(r.pass, true)
  assert.equal(r.comparisons.length, 0)
  assert.match(r.lines.join('\n'), /長さ超過 `too_long` \| 1（100%）/)
})

test('report: 3 つ以上の案は、どれも最初の案と比べる', () => {
  const r = report({ samples: [s('1', 'a'), s('1', 'b'), s('1', 'c', ['action_swap'])], variants: ['a', 'b', 'c'] })
  assert.deepEqual(r.comparisons.map((c) => [c.candidate.variant, c.pass]), [['b', true], ['c', false]])
  assert.equal(r.pass, false)
})
