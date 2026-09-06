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
