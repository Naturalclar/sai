import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultReplyTarget,
  feedReplyTargets,
  filterReplyTargets,
  mentionLabels,
  mentionQuery,
  mergeReplyTargets,
  replyBlockedReason,
  sessionReplyTargets,
  stripMention,
  type ReplyTarget,
} from './reply.ts'
import type { FeedRow, SessionSummary } from './types.ts'

function row(over: Partial<FeedRow>): FeedRow {
  return {
    ts: '2026-09-02T10:00:00+09:00',
    agent: 'claude',
    repo: 'sai',
    branch: 'main',
    session: 's1',
    session_source: 'payload',
    cwd: '/tmp/sai',
    event: 'Stop',
    text: '返答',
    first_user_text: '最初の指示',
    ...over,
  }
}

function summary(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: 's1@sai',
    start: '2026-09-02T10:00:00+09:00',
    end: '2026-09-02T10:10:00+09:00',
    date: '2026-09-02',
    dates: ['2026-09-02'],
    agent: 'claude',
    agents: ['claude'],
    repo: 'sai',
    repos: ['sai'],
    branch: 'main',
    branches: ['main'],
    cwd: '/tmp/sai',
    turns: 2,
    title: '一覧のタイトル',
    title_full: '一覧のタイトル',
    session_source: 'payload',
    sources: ['payload'],
    last_text: '返答',
    waiting: '',
    ...over,
  }
}

test('sessionReplyTargets: 一覧の順のまま。表示名・アイコン画像があればそれ、無ければ一覧のタイトル', () => {
  const targets = sessionReplyTargets([
    summary({ id: 's1@sai', meta: { name: 'CI 整備' }, icon: '/api/sessions/s1%40sai/icon?v=1' }),
    summary({ id: 's2@other', repo: 'other', branch: 'feat', title: 'other の指示' }),
    summary({ id: 's3@sai', icon: '/api/sessions/s3%40sai/icon?v=2' }),
    summary({ id: 'synth-x@sai', session_source: 'synth' }),
    summary({ id: 's4@sai', meta: { name: 'あ'.repeat(70) } }),
  ])
  assert.deepEqual(
    targets.map((t) => [t.id, t.repo, t.branch, t.title, t.icon, t.blocked !== '']),
    [
      ['s1@sai', 'sai', 'main', 'CI 整備', '/api/sessions/s1%40sai/icon?v=1', false],
      ['s2@other', 'other', 'feat', 'other の指示', undefined, false],
      ['s3@sai', 'sai', 'main', '一覧のタイトル', '/api/sessions/s3%40sai/icon?v=2', false],
      ['synth-x@sai', 'sai', 'main', '一覧のタイトル', undefined, true],
      ['s4@sai', 'sai', 'main', `${'あ'.repeat(60)}…`, undefined, false],
    ],
  )
  assert.equal('icon' in targets[1]!, false, 'アイコンが無ければキーごと無い')
})

test('mergeReplyTargets: 一覧が先、フィードにしか無いものが後ろ。同じ id は一覧側が勝つ', () => {
  const list = sessionReplyTargets([summary({ id: 's1@sai', meta: { name: '名前' }, icon: '/i/1' }), summary({ id: 's2@sai' })])
  const feed = feedReplyTargets([
    row({ ts: '2026-09-02T10:00:00+09:00', session: 's3', user_text: 'フィードだけ' }),
    row({ ts: '2026-09-02T10:05:00+09:00', session: 's1', user_text: 'フィード側の指示' }),
  ])
  const merged = mergeReplyTargets(list, feed)
  assert.deepEqual(
    merged.map((t) => [t.id, t.title, t.icon]),
    [
      ['s1@sai', '名前', '/i/1'],
      ['s2@sai', '一覧のタイトル', undefined],
      ['s3@sai', 'フィードだけ', undefined],
    ],
  )
  assert.deepEqual(mergeReplyTargets([], feed), feed, '一覧が空ならフィードだけ')
  assert.deepEqual(mergeReplyTargets(list, []), list)
})

test('feedReplyTargets: エンティティごとに1件、新しい順、ラベルは一番新しい行のもの', () => {
  const rows = [
    row({ ts: '2026-09-02T10:00:00+09:00', session: 's1', branch: 'main', user_text: '最初の指示' }),
    row({ ts: '2026-09-02T10:05:00+09:00', session: 's2', repo: 'other', first_user_text: 'other の指示' }),
    row({ ts: '2026-09-02T10:10:00+09:00', session: 's1', branch: 'feat/x', user_text: '続きの指示\n2行目' }),
  ]
  const targets = feedReplyTargets(rows)
  assert.deepEqual(
    targets.map((t) => [t.id, t.repo, t.branch, t.title, t.blocked]),
    [
      ['s1@sai', 'sai', 'feat/x', '続きの指示', ''],
      ['s2@other', 'other', 'main', 'other の指示', ''],
    ],
  )
})

test('feedReplyTargets: 再開できないものは blocked に理由が入る。タイトルは text にフォールバックして60文字で切る', () => {
  const long = 'あ'.repeat(70)
  const rows = [
    row({ session: 's-synth', session_source: 'synth' }),
    row({ session: '', ts: '2026-09-02T10:01:00+09:00' }),
    row({ session: 's-unknown', agent: 'unknown', ts: '2026-09-02T10:02:00+09:00' }),
    row({ session: 's-notitle', first_user_text: '', text: `${long}\n2行目`, ts: '2026-09-02T10:03:00+09:00' }),
  ]
  const targets = feedReplyTargets(rows)
  assert.equal(targets.length, 4)
  assert.equal(targets[0]!.title, `${'あ'.repeat(60)}…`)
  assert.equal(targets[0]!.blocked, '')
  assert.equal(targets[1]!.blocked, replyBlockedReason({ id: 's-unknown@sai', agent: 'unknown', session_source: 'payload' }))
  assert.match(targets[2]!.id, /^unknown-2026-09-02@sai$/)
  assert.notEqual(targets[2]!.blocked, '')
  assert.equal(targets[3]!.blocked, replyBlockedReason({ id: 's-synth@sai', agent: 'claude', session_source: 'synth' }))
})

test('filterReplyTargets: リポジトリ / ブランチ / タイトルの部分一致、大文字小文字は無視', () => {
  const targets = feedReplyTargets([
    row({ session: 'a', repo: 'sai', branch: 'feat/Markdown', first_user_text: 'PR を作る' }),
    row({ session: 'b', repo: 'dotfiles', branch: 'main', first_user_text: 'zsh の設定', ts: '2026-09-02T10:01:00+09:00' }),
  ])
  assert.deepEqual(filterReplyTargets(targets, '').map((t) => t.id), ['b@dotfiles', 'a@sai'])
  assert.deepEqual(filterReplyTargets(targets, 'markdown').map((t) => t.id), ['a@sai'])
  assert.deepEqual(filterReplyTargets(targets, 'ZSH').map((t) => t.id), ['b@dotfiles'])
  assert.deepEqual(filterReplyTargets(targets, 'DOT').map((t) => t.id), ['b@dotfiles'])
  assert.deepEqual(filterReplyTargets(targets, 'nothing'), [])
})

test('mentionQuery: 行頭か空白の直後の半角 @ だけ。caret までに空白があれば閉じる', () => {
  assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' })
  assert.deepEqual(mentionQuery('@sa', 3), { start: 0, query: 'sa' })
  assert.deepEqual(mentionQuery('直して @sai', 8), { start: 4, query: 'sai' })
  assert.deepEqual(mentionQuery('一行目\n@x', 6), { start: 4, query: 'x' })
  // caret が @ より前なら無い
  assert.equal(mentionQuery('@sai', 0), null)
  // 空白で区切られたら確定済みとみなして閉じる
  assert.equal(mentionQuery('@sai を見て', 7), null)
  // メールアドレスの途中
  assert.equal(mentionQuery('mail me@example.com', 10), null)
  // 全角の ＠ は普通の文字
  assert.equal(mentionQuery('＠sai', 4), null)
  // caret の手前だけを見る（後ろに何があっても関係ない）
  assert.deepEqual(mentionQuery('@sa 後ろ', 3), { start: 0, query: 'sa' })
})

test('mentionLabels: @repo。同じリポジトリが複数なら @repo/branch、それでも被れば ~2', () => {
  const targets = feedReplyTargets([
    row({ session: 'd', repo: 'dotfiles', branch: 'main', ts: '2026-09-02T09:00:00+09:00' }),
    row({ session: 'c', repo: 'sai', branch: 'feat/x', ts: '2026-09-02T09:10:00+09:00' }),
    row({ session: 'b', repo: 'sai', branch: 'feat/x', ts: '2026-09-02T09:20:00+09:00' }),
    row({ session: 'a', repo: 'sai', branch: 'main', ts: '2026-09-02T09:30:00+09:00' }),
  ])
  const labels = mentionLabels(targets)
  assert.equal(labels.get('a@sai'), '@sai/main')
  assert.equal(labels.get('b@sai'), '@sai/feat/x')
  assert.equal(labels.get('c@sai'), '@sai/feat/x~2')
  assert.equal(labels.get('d@dotfiles'), '@dotfiles')
  // 表記は空白を含まないので、後ろに空白を付ければ打ちかけとは見なされない
  assert.equal(mentionQuery('@sai/main ', 10), null)
})

test('stripMention: 表記を外して空白を整える', () => {
  assert.equal(stripMention('@sai/main テスト本文', '@sai/main'), 'テスト本文')
  assert.equal(stripMention('先に @sai/main を見て', '@sai/main'), '先に を見て')
  assert.equal(stripMention('1行目 @sai\n2行目', '@sai'), '1行目\n2行目')
  assert.equal(stripMention('表記なし', '@sai'), '表記なし')
})

test('defaultReplyTarget: 一番新しい行のセッションのうち処理中でないもの。全部処理中なら一番新しいもの', () => {
  const t = (id: string, over: Partial<ReplyTarget> = {}): ReplyTarget => ({ id, repo: id, branch: '', title: '', blocked: '', ...over })
  const feed = [t('a'), t('b'), t('c')] // 新しい順
  const list = [t('b', { title: '一覧の b' }), t('a', { title: '一覧の a' })]
  const targets = mergeReplyTargets(list, feed)
  const none = new Set<string>()
  assert.equal(defaultReplyTarget(feed, targets, none)?.title, '一覧の a', '処理中が無ければ一番新しい a。返すのは一覧側（表示名付き）')
  assert.equal(defaultReplyTarget(feed, targets, new Set(['a']))?.title, '一覧の b', 'a が処理中なら次に新しい b')
  assert.equal(defaultReplyTarget(feed, targets, new Set(['a', 'b']))?.id, 'c', 'c は一覧に無いのでフィード側の候補')
  assert.equal(defaultReplyTarget(feed, targets, new Set(['a', 'b', 'c']))?.id, 'a', '全部処理中なら一番新しいもの（送信だけ止める）')
  // 再開できないものは飛ばす
  const blockedFirst = [t('x', { blocked: '合成' }), t('y')]
  assert.equal(defaultReplyTarget(blockedFirst, blockedFirst, none)?.id, 'y')
  // フィードに何も無ければ一覧から同じ基準で
  assert.equal(defaultReplyTarget([], list, new Set(['b']))?.id, 'a')
  assert.equal(defaultReplyTarget([], list, new Set(['a', 'b']))?.id, 'b', '一覧も全部処理中なら先頭')
  assert.equal(defaultReplyTarget([], [], none), null)
  assert.equal(defaultReplyTarget([t('x', { blocked: '合成' })], [t('x', { blocked: '合成' })], none), null, '再開できるものが無ければ null')
})
