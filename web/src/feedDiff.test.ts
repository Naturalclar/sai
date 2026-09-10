import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedRow, SessionDiffSummaryResponse } from '../../shared/types.ts'
import { nextDiff, opensDiff, prStamps, visibleDiff } from './feedDiff.ts'

const REMOTE = 'https://github.com/Naturalclar/sai'
const SELF = 'mac'

function row(over: Partial<FeedRow>): FeedRow {
  return {
    ts: '2026-09-10T10:00:00+09:00',
    agent: 'claude',
    repo: 'sai',
    branch: 'issue-12',
    remote: REMOTE,
    session: 's1',
    session_source: 'payload',
    cwd: '/tmp/sai',
    event: 'Stop',
    text: '返答',
    ...over,
  }
}

function summary(over: Partial<SessionDiffSummaryResponse>): SessionDiffSummaryResponse {
  return {
    id: 's1@sai',
    base: 'main',
    head: 'abc123',
    files: 3,
    added: 40,
    removed: 2,
    branch: { files: 3, added: 40, removed: 2 },
    working: { files: 0, added: 0, removed: 0 },
    untracked: 0,
    pr: { number: 12, url: `${REMOTE}/pull/12`, state: 'OPEN', draft: false },
    ...over,
  }
}

// ---- prStamps: どのセッションを取りに行くか

test('prStamps: 番号に触れたセッションだけ。目印は最後のターン完了の ts', () => {
  const stamps = prStamps([
    row({ session: 's1', ts: '2026-09-10T10:00:00+09:00', text: `PR を作りました: ${REMOTE}/pull/12` }),
    row({ session: 's2', ts: '2026-09-10T10:05:00+09:00', text: 'テストを直しました' }),
    // 番号に触れた後のターン。ブランチや PR が変わりうるので、こちらを目印にする
    row({ session: 's1', ts: '2026-09-10T10:30:00+09:00', text: 'CI が通りました' }),
    // 入力の行はターンではない（差分は変わっていない）
    row({ session: 's1', ts: '2026-09-10T10:40:00+09:00', event: 'UserPromptSubmit', text: '', user_text: 'マージして' }),
  ], SELF)
  assert.deepEqual([...stamps], [['s1@sai', '2026-09-10T10:30:00+09:00']])
})

test('prStamps: 裸の #N と同じリポジトリの owner/repo#N は数える。別のリポジトリの番号は数えない', () => {
  const stamps = prStamps([
    row({ session: 'a', text: '#280 に着手します' }),
    row({ session: 'b', text: 'Naturalclar/sai#12 を見てください' }),
    row({ session: 'c', text: 'facebook/react#123 の件' }),
    row({ session: 'd', text: '色は #fff にしました' }),
  ], SELF)
  assert.deepEqual([...stamps.keys()], ['a@sai', 'b@sai'])
})

test('prStamps: 待ちの行、別のマシンの行、セッションの無い行は見ない', () => {
  const stamps = prStamps([
    row({ session: 'w', event: 'PermissionRequest', text: '許可待ち: Bash: gh pr view 12' }),
    row({ session: 'w2', event: 'PermissionRequest', text: '許可待ち: Bash: gh pr merge #12' }),
    row({ session: 'r', host: 'mini', text: `${REMOTE}/pull/7` }),
    row({ session: '', text: '#7 を作りました' }),
  ], SELF)
  assert.deepEqual([...stamps], [])
  // 同じマシンの行と、host の無い古い行は見る
  assert.equal(prStamps([row({ session: 'm', host: 'mac', text: '#7' })], SELF).size, 1)
  assert.equal(prStamps([row({ session: 'o', text: '#7' })], SELF).size, 1)
})

// ---- opensDiff: どのバブルにボタンを出すか

test('opensDiff: いまのブランチの PR の番号に触れているバブルだけ', () => {
  const s = summary({})
  assert.equal(opensDiff(`PR を作りました: ${REMOTE}/pull/12`, REMOTE, s), true, 'URL')
  assert.equal(opensDiff('PR #12 を作りました', REMOTE, s), true, '裸の #N')
  assert.equal(opensDiff('Naturalclar/sai#12 を作りました', REMOTE, s), true, '同じリポジトリの owner/repo#N')
})

test('opensDiff: 古い PR のバブルには出さない（押すといまの別のブランチの差分が出てしまう）', () => {
  const s = summary({})
  assert.equal(opensDiff(`${REMOTE}/pull/11 をマージしました`, REMOTE, s), false)
  assert.equal(opensDiff('#11 をマージしました', REMOTE, s), false)
})

test('opensDiff: 番号の一部や別のリポジトリの同じ番号には当てない', () => {
  const s = summary({})
  assert.equal(opensDiff('#123 を作りました', REMOTE, s), false, '#123 は #12 ではない')
  assert.equal(opensDiff('#1 を作りました', REMOTE, s), false)
  assert.equal(opensDiff('facebook/react#12 の件', REMOTE, s), false)
  assert.equal(opensDiff('https://github.com/facebook/react/pull/12', REMOTE, s), false)
})

test('opensDiff: PR が無い・差分が空・取れていないなら出さない', () => {
  const text = 'PR #12 を作りました'
  assert.equal(opensDiff(text, REMOTE, undefined), false, 'まだ取れていない')
  const { pr: _pr, ...noPr } = summary({})
  assert.equal(opensDiff(text, REMOTE, noPr), false, 'いまのブランチに PR が無い')
  assert.equal(opensDiff(text, REMOTE, summary({ files: 0, untracked: 0 })), false, '開いても空')
  assert.equal(opensDiff(text, REMOTE, summary({ files: 0, untracked: 2 })), true, '追跡外だけでも中身はある')
})

// ---- visibleDiff / nextDiff: どの画面で出したままにするか

test('visibleDiff: セッションで開いたものは、そのセッションにいる間だけ（今までどおり）', () => {
  const d = { id: 's1@sai', origin: 'session' as const }
  assert.equal(visibleDiff(d, { name: 'session', id: 's1@sai' }, false), 's1@sai')
  assert.equal(visibleDiff(d, { name: 'session', id: 's2@sai' }, false), null, '別のセッション')
  assert.equal(visibleDiff(d, { name: 'feed' }, false), null, 'フィードでは出さない')
  assert.equal(visibleDiff(d, { name: 'list' }, false), null)
  assert.equal(visibleDiff(d, { name: 'todo' }, false), null)
  assert.equal(visibleDiff(null, { name: 'feed' }, false), null)
})

test('visibleDiff: フィードから開いたものは、フィードとそのセッションで出す', () => {
  const d = { id: 's1@sai', origin: 'feed' as const }
  assert.equal(visibleDiff(d, { name: 'feed' }, false), 's1@sai')
  assert.equal(visibleDiff(d, { name: 'feed' }, true), 's1@sai', '狭い画面の #/feed はモーダル')
  assert.equal(visibleDiff(d, { name: 'list' }, false), 's1@sai', '広い画面の #/ はフィードと同じ表示')
  assert.equal(visibleDiff(d, { name: 'list' }, true), null, '狭い画面の #/ は一覧だけでフィードが見えていない')
  assert.equal(visibleDiff(d, { name: 'session', id: 's1@sai' }, false), 's1@sai')
  assert.equal(visibleDiff(d, { name: 'session', id: 's2@sai' }, false), null)
  assert.equal(visibleDiff(d, { name: 'todo' }, false), null)
})

test('nextDiff: 出ているものを押すと閉じる。覚えているだけで出ていないものを押すと開く', () => {
  assert.equal(nextDiff('s1@sai', 's1@sai', 'feed'), null)
  assert.deepEqual(nextDiff(null, 's1@sai', 'feed'), { id: 's1@sai', origin: 'feed' })
  assert.deepEqual(nextDiff('s2@sai', 's1@sai', 'feed'), { id: 's1@sai', origin: 'feed' }, '別のを出していれば差し替える')

  // セッションで開いたままフィードに来ると、覚えてはいるが出ていない（visibleDiff が null）。
  // ここで同じセッションのバブルを押したら、閉じるのではなく開く（1 回目の押下を空振りさせない）
  const remembered = { id: 's1@sai', origin: 'session' as const }
  const onFeed = visibleDiff(remembered, { name: 'feed' }, false)
  assert.deepEqual(nextDiff(onFeed, 's1@sai', 'feed'), { id: 's1@sai', origin: 'feed' })
})
