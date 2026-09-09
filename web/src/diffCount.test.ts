import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionDiffSummaryResponse } from '../../shared/types.ts'
import { diffTitle, hasDiff, shortCount } from './diffCount.ts'

const base: SessionDiffSummaryResponse = {
  id: 'x@sai',
  base: 'origin/main',
  head: 'feat/x',
  files: 0,
  added: 0,
  removed: 0,
  branch: { files: 0, added: 0, removed: 0 },
  working: { files: 0, added: 0, removed: 0 },
  untracked: 0,
}

test('shortCount: 4 桁から k で丸める（狭いボタンに収める）', () => {
  assert.equal(shortCount(0), '0')
  assert.equal(shortCount(7), '7')
  assert.equal(shortCount(999), '999')
  assert.equal(shortCount(1000), '1.0k')
  assert.equal(shortCount(1249), '1.2k')
  assert.equal(shortCount(1250), '1.2k', '切り上げない（実際より多く見せない）')
  assert.equal(shortCount(9999), '9.9k')
  assert.equal(shortCount(10_000), '10k', '2 桁の k は小数を落とす')
  assert.equal(shortCount(123_456), '123k')
})

test('hasDiff: 変わったファイルか追跡外か PR があれば「ある」', () => {
  assert.equal(hasDiff(base), false, '何も無ければボタンを出さない')
  assert.equal(hasDiff({ ...base, files: 1 }), true)
  assert.equal(hasDiff({ ...base, untracked: 1 }), true, '追跡外だけでも出す')
  assert.equal(hasDiff({ ...base, files: 1, added: 0, removed: 0 }), true, 'バイナリだけ（行が 0）でも出す')
  assert.equal(hasDiff({ ...base, pr: { number: 3, url: '', state: 'OPEN', draft: false } }), true, 'PR があれば出す')
})

test('diffTitle: 内訳と PR の状態を出す（ボタンには合計しか出ない）', () => {
  const s: SessionDiffSummaryResponse = {
    ...base,
    files: 2,
    added: 3,
    removed: 2,
    branch: { files: 2, added: 2, removed: 1 },
    working: { files: 1, added: 1, removed: 1 },
    untracked: 1,
    pr: { number: 211, url: 'https://x/pull/211', state: 'OPEN', draft: false },
  }
  const title = diffTitle(s, false)
  assert.match(title, /^差分を見る$/m)
  assert.match(title, /ブランチの差分（origin\/main\.\.\.feat\/x）: 2 ファイル \+2 -1/)
  assert.match(title, /未コミット: 1 ファイル \+1 -1/)
  assert.match(title, /追跡外: 1 ファイル/)
  assert.match(title, /PR #211（オープン）/)

  assert.match(diffTitle(s, true), /^差分を閉じる$/m, '開いているときは「閉じる」')
  assert.equal(diffTitle(null, false), '差分を見る', 'まだ取れていなければ内訳は出さない')
})

test('diffTitle: base が無ければその旨を出し、PR の状態も言い換える', () => {
  const noBase = diffTitle({ ...base, base: '', working: { files: 1, added: 1, removed: 0 } }, false)
  assert.match(noBase, /比べる相手のブランチが見つかりません/)
  assert.ok(!noBase.includes('追跡外'), '追跡外が 0 なら行ごと出さない')

  const merged = diffTitle({ ...base, pr: { number: 9, url: '', state: 'MERGED', draft: false } }, false)
  assert.match(merged, /PR #9（マージ済み）/)
  const closed = diffTitle({ ...base, pr: { number: 9, url: '', state: 'CLOSED', draft: false } }, false)
  assert.match(closed, /PR #9（クローズ済み）/)
  const draft = diffTitle({ ...base, pr: { number: 9, url: '', state: 'OPEN', draft: true } }, false)
  assert.match(draft, /PR #9（下書き）/)
})
