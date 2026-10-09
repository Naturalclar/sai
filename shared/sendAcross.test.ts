import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEND_ACROSS_MAX, addPair, cleanPairs, mayCross, pairLabel, readPairs, removePair } from './sendAcross.ts'

test('mayCross: 組は向きつき。許した向きだけ通し、同じリポジトリ・空の名前は「またぐ」に数えない（#747）', () => {
  const pairs = [{ from: 'o/repo-a', to: 'o/repo-b' }]
  assert.equal(mayCross(pairs, 'o/repo-a', 'o/repo-b'), true)
  assert.equal(mayCross(pairs, 'o/repo-b', 'o/repo-a'), false, '逆向きは別に許す')
  assert.equal(mayCross(pairs, 'O/Repo-A', 'o/REPO-b'), true, '名前は大文字小文字を見ない')
  assert.equal(mayCross(pairs, 'o/repo-a', 'o/repo-c'), false)
  assert.equal(mayCross(pairs, 'o/repo-a', 'o/repo-a'), false)
  assert.equal(mayCross(pairs, '', 'o/repo-b'), false)
  assert.equal(mayCross([], 'o/repo-a', 'o/repo-b'), false, '既定（空）ではどこにもまたげない')
})

test('cleanPairs: 記録で知っているリポジトリだけを通し、名前はその書き方に揃える。同じ組は 1 つ（#747）', () => {
  const known = ['o/repo-a', 'o/repo-b', 'o/repo-c']
  assert.deepEqual(cleanPairs([{ from: 'O/Repo-A', to: ' o/repo-b ' }, { from: 'o/repo-a', to: 'o/repo-b' }, { from: 'o/repo-b', to: 'o/repo-a' }], known), [
    { from: 'o/repo-a', to: 'o/repo-b' },
    { from: 'o/repo-b', to: 'o/repo-a' },
  ])
  assert.deepEqual(cleanPairs([], known), [], '空で全部やめる')
  assert.match(cleanPairs([{ from: 'o/repo-a', to: 'o/unknown' }], known) as string, /記録で知っているリポジトリだけ.*o\/unknown/)
  assert.match(cleanPairs([{ from: 'o/repo-a', to: 'o/repo-a' }], known) as string, /同じリポジトリの中は、いつでも送れます/)
  for (const bad of ['x', { from: 'o/repo-a', to: 'o/repo-b' }, [{ from: 'o/repo-a' }], [null], [{ from: 1, to: 2 }]]) {
    assert.equal(typeof cleanPairs(bad, known), 'string', JSON.stringify(bad))
  }
  assert.match(cleanPairs(Array.from({ length: SEND_ACROSS_MAX + 1 }, () => ({ from: 'o/repo-a', to: 'o/repo-b' })), known) as string, /組までです/)
})

test('readPairs: 設定のファイルからは読める組だけを拾う（1 つ壊れていても、ほかを捨てない）。pairLabel は A → B', () => {
  assert.deepEqual(readPairs([{ from: 'o/repo-a', to: 'o/repo-b' }, { from: 'o/repo-a' }, 'x', { from: 'o/repo-a', to: 'o/repo-a' }, { from: 'o/repo-a', to: 'o/repo-b' }]), [{ from: 'o/repo-a', to: 'o/repo-b' }])
  assert.deepEqual(readPairs(undefined), [])
  assert.deepEqual(readPairs({ from: 'o/repo-a', to: 'o/repo-b' }), [])
  assert.equal(pairLabel({ from: 'o/repo-a', to: 'o/repo-b' }), 'o/repo-a → o/repo-b')
})

test('addPair / removePair: 1 つずつ足す・外す。いま持っている組は検査し直さない（#747）', () => {
  const known = ['o/repo-a', 'o/repo-b']
  // 片方が記録の窓から出た古い組があっても、ほかの組を足せる・外せる
  const stale = [{ from: 'o/gone', to: 'o/repo-a' }]
  assert.deepEqual(addPair(stale, { from: 'O/Repo-A', to: 'o/repo-b' }, known), [...stale, { from: 'o/repo-a', to: 'o/repo-b' }])
  assert.deepEqual(removePair(stale, { from: 'o/gone', to: 'o/repo-a' }), [], '記録に無い名前の組でも外せる')
  assert.deepEqual(addPair([{ from: 'o/repo-a', to: 'o/repo-b' }], { from: 'o/repo-a', to: 'o/repo-b' }, known), [{ from: 'o/repo-a', to: 'o/repo-b' }], 'もうあれば増えない')
  assert.match(addPair([], { from: 'o/repo-a', to: 'o/unknown' }, known) as string, /記録で知っているリポジトリだけ/)
  assert.match(addPair([], { from: 'o/repo-a', to: 'o/repo-a' }, known) as string, /同じリポジトリ/)
  assert.match(addPair([], 'x', known) as string, /send_across_add は \{ from, to \}/)
  assert.match(addPair(Array.from({ length: SEND_ACROSS_MAX }, (_, n) => ({ from: `o/x${n}`, to: 'o/y' })), { from: 'o/repo-a', to: 'o/repo-b' }, known) as string, /組までです/)
  assert.deepEqual(removePair([{ from: 'o/repo-a', to: 'o/repo-b' }], { from: 'o/repo-b', to: 'o/repo-a' }), [{ from: 'o/repo-a', to: 'o/repo-b' }], '逆向きは別の組')
  assert.match(removePair([], [1]) as string, /send_across_remove は \{ from, to \}/)
})
