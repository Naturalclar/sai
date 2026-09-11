import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLinearWorkspace, linkifyRefs } from './refs.ts'
import type { Inline } from './markdown.ts'

const t = (text: string): Inline => ({ kind: 'text', text })
const a = (href: string, text: string): Inline => ({ kind: 'link', href, children: [t(text)] })
const GH = { remote: 'https://github.com/Naturalclar/sai' }

test('#123 / PR #123 は remote の issues に。remote が無ければ文字のまま', () => {
  assert.deepEqual(linkifyRefs('PR #79 マージ、#76 も close 完了！', GH), [
    t('PR '),
    a('https://github.com/Naturalclar/sai/issues/79', '#79'),
    t(' マージ、'),
    a('https://github.com/Naturalclar/sai/issues/76', '#76'),
    t(' も close 完了！'),
  ])
  assert.deepEqual(linkifyRefs('PR #79 マージ', {}), [t('PR #79 マージ')])
  assert.deepEqual(linkifyRefs('#79', { remote: 'https://gitlab.example.com/a/b' }), [t('#79')], 'GitHub 以外の remote は組まない')
})

test('owner/repo#123 は remote に関係なくそのリポジトリへ', () => {
  assert.deepEqual(linkifyRefs('acme/kanban#12 を見て', {}), [a('https://github.com/acme/kanban/issues/12', 'acme/kanban#12'), t(' を見て')])
})

test('参照でないものは触らない: URL の途中の #、&#123;、a#1、code の中', () => {
  const url = 'https://github.com/Naturalclar/sai/pull/12#issuecomment-5'
  assert.deepEqual(linkifyRefs(`見て ${url}`, GH), [t('見て '), a(url, url)])
  assert.deepEqual(linkifyRefs('&#123; と a#1 と x/y/z#3', GH), [t('&#123; と a#1 と x/y/z#3')])
  assert.deepEqual(linkifyRefs('`#12` はコード', GH), [{ kind: 'code', text: '#12' }, t(' はコード')])
  assert.deepEqual(linkifyRefs('#12abc', GH), [t('#12abc')], '後ろに英数字が続く')
})

test('一言の中の画像への参照（#321）: [名前](パス) の Markdown を文字のまま出さず、画像のノードにする', () => {
  const path = '/Users/me/sai.git/dev-codex/docs/assets/codex-agent-icon.png'
  assert.deepEqual(linkifyRefs(`Codex用アイコン作成！[codex-agent-icon.png](${path}) 1254×1254px透過PNG。🎨`, GH), [
    t('Codex用アイコン作成！'),
    { kind: 'image', src: path, alt: 'codex-agent-icon.png' },
    t(' 1254×1254px透過PNG。🎨'),
  ])
})

test('太字の中の番号もリンクになる', () => {
  assert.deepEqual(linkifyRefs('**#5 完了**', GH), [{ kind: 'strong', children: [a('https://github.com/Naturalclar/sai/issues/5', '#5'), t(' 完了')] }])
})

test('Linear の識別子は workspace があるときだけ。SHA-256 のような語は除く', () => {
  assert.deepEqual(linkifyRefs('PGR-10891 を直した', { linear: 'acme' }), [a('https://linear.app/acme/issue/PGR-10891', 'PGR-10891'), t(' を直した')])
  assert.deepEqual(linkifyRefs('PGR-10891 を直した', {}), [t('PGR-10891 を直した')])
  assert.deepEqual(linkifyRefs('SHA-256 と UTF-8 と CVE-2024-1234 と ABC-1-2', { linear: 'acme' }), [t('SHA-256 と UTF-8 と CVE-2024-1234 と ABC-1-2')])
  assert.deepEqual(linkifyRefs('xPGR-1 pgr-1 PGR-1x', { linear: 'acme' }), [t('xPGR-1 pgr-1 PGR-1x')], '前後に英数字、小文字は除く')
})

test('GitHub と Linear と URL が混ざる', () => {
  const out = linkifyRefs('#3 と PGR-7 と https://x.test/ok', { ...GH, linear: 'acme' })
  assert.deepEqual(out.filter((n) => n.kind === 'link').map((n) => (n.kind === 'link' ? n.href : '')), [
    'https://github.com/Naturalclar/sai/issues/3',
    'https://linear.app/acme/issue/PGR-7',
    'https://x.test/ok',
  ])
})

test('isLinearWorkspace', () => {
  assert.equal(isLinearWorkspace(''), true)
  assert.equal(isLinearWorkspace('acme'), true)
  assert.equal(isLinearWorkspace('my-team-2'), true)
  assert.equal(isLinearWorkspace('Acme'), false)
  assert.equal(isLinearWorkspace('a b'), false)
  assert.equal(isLinearWorkspace(1), false)
})

// ---- #268: 一言が本文に無い番号を書く（プロンプトの作例の数字を写す）ので、それはリンクにしない

test('source を渡すと、本文に無い番号は文字のまま（本文にある番号は今までどおりリンク）', () => {
  const ctx = { ...GH, source: '#256 をマージしました。次は #12345 を見ます' }
  // 本文にある番号はリンク
  assert.deepEqual(linkifyRefs('PR #256 マージ完了', ctx), [t('PR '), a('https://github.com/Naturalclar/sai/issues/256', '#256'), t(' マージ完了')])
  // 本文に無い番号（プロンプトの作例の #12）は文字のまま。消さずに残す
  assert.deepEqual(linkifyRefs('PR #12 作成、ollama 導入で条件緩和', ctx), [t('PR #12 作成、ollama 導入で条件緩和')])
})

test('source を渡さなければ今までどおり全部リンクになる（後方互換）', () => {
  assert.deepEqual(linkifyRefs('PR #12 作成', GH), [t('PR '), a('https://github.com/Naturalclar/sai/issues/12', '#12'), t(' 作成')])
})

test('本文の #1234 は一言の #123 の裏付けにしない（前方一致で当てない）', () => {
  // 素朴に source.includes('#123') で見ると本文の #1234 に当たってしまう
  const ctx = { ...GH, source: '#1234 を直した' }
  assert.deepEqual(linkifyRefs('#123 を直した', ctx), [t('#123 を直した')])
  assert.deepEqual(linkifyRefs('#1234 を直した', ctx), [a('https://github.com/Naturalclar/sai/issues/1234', '#1234'), t(' を直した')])
})

test('owner/repo#123 は source に関係なくリンク（行き先を自分で名乗っている）', () => {
  const ctx = { ...GH, source: '番号の無い本文' }
  assert.deepEqual(linkifyRefs('acme/kanban#7 を見る', ctx), [a('https://github.com/acme/kanban/issues/7', 'acme/kanban#7'), t(' を見る')])
})

test('本文の owner/repo#123 は、その owner/repo が remote と同じときだけ裸の #123 を裏付ける', () => {
  // 同じリポジトリを名前付きで書いてあるだけなので、一言が裸で書いても向き先は同じ
  const same = { ...GH, source: 'Naturalclar/sai#256 をマージ' }
  assert.deepEqual(linkifyRefs('#256 マージ', same), [a('https://github.com/Naturalclar/sai/issues/256', '#256'), t(' マージ')])
  // 別のリポジトリの番号は、このリポジトリの番号として飛ばさない
  const other = { ...GH, source: 'acme/kanban#256 を見た' }
  assert.deepEqual(linkifyRefs('#256 マージ', other), [t('#256 マージ')])
})

test('Linear の識別子も同じ規則（本文に無ければ文字のまま）', () => {
  const ctx = { remote: GH.remote, linear: 'acme', source: 'PGR-10891 を直した' }
  assert.deepEqual(linkifyRefs('PGR-10891 完了', ctx), [a('https://linear.app/acme/issue/PGR-10891', 'PGR-10891'), t(' 完了')])
  assert.deepEqual(linkifyRefs('PGR-99999 完了', ctx), [t('PGR-99999 完了')])
})

test('URL はそのまま（source に無くても切らない）', () => {
  const ctx = { ...GH, source: '番号の無い本文' }
  assert.deepEqual(linkifyRefs('https://example.com/x を見た', ctx), [
    a('https://example.com/x', 'https://example.com/x'),
    t(' を見た'),
  ])
})

test('本文が URL で番号を出していれば裏付けになる（エージェントは URL を貼り、モデルは #70 と書く）', () => {
  const ctx = { ...GH, source: 'https://github.com/Naturalclar/sai/issues/70 を立てました' }
  assert.deepEqual(linkifyRefs('Issue #70 立てた', ctx), [t('Issue '), a('https://github.com/Naturalclar/sai/issues/70', '#70'), t(' 立てた')])
  // /pull/ でも同じ（GitHub は issues/<n> で PR にも飛ぶ）
  const pr = { ...GH, source: 'https://github.com/Naturalclar/sai/pull/262 を出した' }
  assert.deepEqual(linkifyRefs('PR #262 出した', pr), [t('PR '), a('https://github.com/Naturalclar/sai/issues/262', '#262'), t(' 出した')])
})

test('別のリポジトリの URL は、このリポジトリの番号の裏付けにしない', () => {
  // 実データにあった形: dotfiles の PR 番号が sai の issue として貼られていた
  const ctx = { ...GH, source: 'https://github.com/Naturalclar/dotfiles/pull/355 を出した' }
  assert.deepEqual(linkifyRefs('PR #355 開いた', ctx), [t('PR #355 開いた')])
})
