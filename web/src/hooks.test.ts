import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRoute, sessionHash } from './hooks.ts'
import { prExplainHash, prHash } from '../../shared/prs.ts'

test('parseRoute: 画面の振り分け', () => {
  assert.deepEqual(parseRoute('#/feed'), { name: 'feed' })
  assert.deepEqual(parseRoute('#/todo'), { name: 'todo' })
  assert.deepEqual(parseRoute('#/new'), { name: 'new' }, '新しいセッション（#314）')
  assert.deepEqual(parseRoute('#/'), { name: 'list' })
  assert.deepEqual(parseRoute(''), { name: 'list' })
  assert.deepEqual(parseRoute('#/s/S1%40sai'), { name: 'session', id: 'S1@sai' })
})

test('parseRoute: 検索から飛んできた ts を取る（#230）', () => {
  assert.deepEqual(parseRoute('#/s/S1%40sai?ts=2026-09-09T23%3A14%3A42%2B09%3A00'), {
    name: 'session',
    id: 'S1@sai',
    ts: '2026-09-09T23:14:42+09:00',
  })
  // ts が無ければキーごと付けない（普通のセッションと同じ形）
  assert.deepEqual(parseRoute('#/s/S1%40sai'), { name: 'session', id: 'S1@sai' })
  assert.deepEqual(parseRoute('#/s/S1%40sai?ts='), { name: 'session', id: 'S1@sai' }, '空の ts は無いのと同じ')
  assert.deepEqual(parseRoute('#/s/S1%40sai?x=1'), { name: 'session', id: 'S1@sai' }, '知らないキーは見ない')
})

test('parseRoute: id は encodeURIComponent 済みなので ? を含まない（%3F になる）', () => {
  // 生の `?` を含む id は作られないが、来ても id 側を壊さない
  assert.deepEqual(parseRoute('#/s/a%3Fb%40sai'), { name: 'session', id: 'a?b@sai' })
})

test('parseRoute: 壊れた %-エンコードでも落ちない', () => {
  const r = parseRoute('#/s/%E0%A4%A')
  assert.equal(r.name, 'session')
  assert.equal(r.name === 'session' && r.id, '%E0%A4%A', 'そのままにして「無いセッション」に落とす')
})

test('sessionHash: parseRoute と往復する', () => {
  const id = 'S1@sai'
  const ts = '2026-09-09T23:14:42+09:00'
  assert.deepEqual(parseRoute(sessionHash(id, ts)), { name: 'session', id, ts })
  assert.deepEqual(parseRoute(sessionHash(id)), { name: 'session', id })
  // `+` や `:` を含む ts が生で入らない（`+` は空白に化ける）
  assert.ok(!sessionHash(id, ts).includes('+'))
})

test('parseRoute / sessionHash: 発言へのリンクはどちら側かも持つ（#503）', () => {
  const id = 'S1@sai'
  const ts = '2026-09-09T23:14:42+09:00'
  // 1 本の行から自分の入力と返答が同じ ts で出るので、side で名指しする
  assert.deepEqual(parseRoute(sessionHash(id, ts, 'me')), { name: 'session', id, ts, side: 'me' })
  assert.deepEqual(parseRoute(sessionHash(id, ts, 'agent')), { name: 'session', id, ts, side: 'agent' })
  // 検索の飛び先（side 無し）は今までどおりの形
  assert.equal(sessionHash(id, ts), `#/s/S1%40sai?ts=${encodeURIComponent(ts)}`)
  // 知らない side は付けない（どちらでも先に見つかった方に着く）
  assert.deepEqual(parseRoute(`#/s/S1%40sai?ts=${encodeURIComponent(ts)}&side=x`), { name: 'session', id, ts })
  // ts が無ければ side だけあっても普通のセッション
  assert.deepEqual(parseRoute('#/s/S1%40sai?side=me'), { name: 'session', id })
})

test('parseRoute: GitHub の PR（#524）。1 本は owner/repo/番号、壊れていれば一覧へ', () => {
  assert.deepEqual(parseRoute('#/prs'), { name: 'prs' })
  assert.deepEqual(parseRoute('#/usage'), { name: 'usage' }, '使用量の画面（#602）')
  assert.deepEqual(parseRoute('#/pr/Naturalclar/sai/524'), { name: 'pr', repo: 'Naturalclar/sai', number: 524 })
  assert.deepEqual(parseRoute('#/pr/Naturalclar/sai/0'), { name: 'prs' })
  assert.deepEqual(parseRoute('#/pr/Naturalclar/sai/abc'), { name: 'prs' })
  assert.deepEqual(parseRoute('#/pr/Naturalclar/524'), { name: 'prs' })
  assert.deepEqual(parseRoute('#/pr/a/%E0%A4%A/1'), { name: 'prs' })
  assert.deepEqual(parseRoute('#/pr/a%2Fb/c/3'), { name: 'prs' }, '名前に / が入るものは受けない（解説のペインと同じ読み方）')
})

test('parseRoute: PR の解説のペイン（#887）。形は PR 1 本と同じで、壊れていれば一覧へ。hash から組んだものは読み戻せる', () => {
  assert.deepEqual(parseRoute('#/pr-explain/owner-a/repo-a/12'), { name: 'pr-explain', repo: 'owner-a/repo-a', number: 12 })
  // 並び（localStorage）に置けない名前（ほどくと `/` `?` `#` が入る）も受けない。受けると、再読み込みでペインが消えて URL とずれる
  for (const bad of ['#/pr-explain/owner-a/repo-a/0', '#/pr-explain/owner-a/repo-a/x', '#/pr-explain/owner-a/12', '#/pr-explain/a/%E0%A4%A/1', '#/pr-explain/', '#/pr-explain/a%2Fb/c/3', '#/pr-explain/a/b%3Fc/3', '#/pr-explain/a/b%23c/3']) {
    assert.deepEqual(parseRoute(bad), { name: 'prs' }, bad)
  }
  assert.deepEqual(parseRoute(prExplainHash('owner-a/repo.a', 7)), { name: 'pr-explain', repo: 'owner-a/repo.a', number: 7 })
  assert.deepEqual(parseRoute(prHash('owner-a/repo.a', 7)), { name: 'pr', repo: 'owner-a/repo.a', number: 7 })
  // `%` や空白など GitHub の名前に入らない文字は受けない。受けると、`prExplainHash()`（エンコードしない）で組み直した hash が
  // 読めず（`a%b` は decodeURIComponent が投げる）、フォーカスを動かしたときに解説のペインが PR の一覧に入れ替わる
  for (const bad of ['#/pr-explain/a%25b/c/1', '#/pr-explain/a%20b/c/1', '#/pr-explain/a/c%2Bd/1', '#/pr/a%25b/c/1']) {
    assert.deepEqual(parseRoute(bad), { name: 'prs' }, bad)
  }
  // 受けた名前は、組み直しても同じものに読み戻る
  for (const repo of ['Owner_A/repo-a.js', 'o.o/r_r-1']) {
    const at = parseRoute(prExplainHash(repo, 3))
    assert.deepEqual(at, { name: 'pr-explain', repo, number: 3 })
    assert.deepEqual(parseRoute(prExplainHash((at as { repo: string }).repo, 3)), at)
  }
})
