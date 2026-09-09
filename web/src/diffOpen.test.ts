import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTO_OPEN_LINES, autoOpenPaths } from './diffOpen.ts'

test('autoOpenPaths: 予算に収まるうちは全部開く', () => {
  const files = [
    { path: 'a.ts', lines: 10 },
    { path: 'b.ts', lines: 20 },
    { path: 'c.ts', lines: 30 },
  ]
  assert.deepEqual([...autoOpenPaths(files, 100)], ['a.ts', 'b.ts', 'c.ts'])
  // ちょうど予算ぴったりでも開く
  assert.deepEqual([...autoOpenPaths(files, 60)], ['a.ts', 'b.ts', 'c.ts'])
})

test('autoOpenPaths: 予算を超えたらそこから先は閉じたまま', () => {
  const files = [
    { path: 'a.ts', lines: 10 },
    { path: 'b.ts', lines: 20 },
    { path: 'c.ts', lines: 30 },
  ]
  assert.deepEqual([...autoOpenPaths(files, 59)], ['a.ts', 'b.ts'], 'c を足すと超える')
  assert.deepEqual([...autoOpenPaths(files, 10)], ['a.ts'])
  // 超えたところで止める（後ろに小さいファイルがあっても拾わない。上から読む順を崩さないため）
  assert.deepEqual([...autoOpenPaths([{ path: 'big.ts', lines: 999 }, { path: 'small.ts', lines: 1 }], 100)], [])
})

test('autoOpenPaths: 1 件目が予算より大きくても開かない（開いた瞬間に固まるのを防ぐのが目的）', () => {
  assert.deepEqual([...autoOpenPaths([{ path: 'huge.ts', lines: 50000 }], 4000)], [])
})

test('autoOpenPaths: 空でも落ちない。行の無いファイルは予算を使わない', () => {
  assert.deepEqual([...autoOpenPaths([])], [])
  const empty = [{ path: 'mode-only.ts', lines: 0 }, { path: 'a.ts', lines: 5 }]
  assert.deepEqual([...autoOpenPaths(empty, 5)], ['mode-only.ts', 'a.ts'])
})

test('AUTO_OPEN_LINES: 実測の差分（最大 1903 行）は全部開く大きさ', () => {
  assert.ok(AUTO_OPEN_LINES >= 1903 * 2, `実測の 2 倍は見込む（いまの値: ${AUTO_OPEN_LINES}）`)
  // サーバ側の上限（1 セクション 2MB ≒ 5 万行）を開ききらないこと
  assert.ok(AUTO_OPEN_LINES < 50000)
})
