import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Authenticator, loginFromWhois, tailscaleBins, whoisFromJson } from './auth.ts'
import type { WhoisInfo } from './auth.ts'
import type { IncomingMessage } from 'node:http'

/** ヘッダと接続元だけを持つ偽の IncomingMessage */
function req(headers: Record<string, string>, remote = '127.0.0.1'): IncomingMessage {
  return { headers, socket: { remoteAddress: remote } } as unknown as IncomingMessage
}

const user = (login: string, caps: WhoisInfo['caps'] = {}): WhoisInfo => ({ login, tagged: false, node: 'laptop', caps })
const tagged = (caps: WhoisInfo['caps'] = {}): WhoisInfo => ({ login: 'tagged-devices', tagged: true, node: 'ci', caps })

test('loginFromWhois: UserProfile.LoginName を取る。形が違えば null', () => {
  assert.equal(loginFromWhois(JSON.stringify({ Node: {}, UserProfile: { LoginName: 'a@example.com' } })), 'a@example.com')
  assert.equal(loginFromWhois(JSON.stringify({ Node: {} })), null)
  assert.equal(loginFromWhois(JSON.stringify({ UserProfile: { LoginName: 1 } })), null)
  assert.equal(loginFromWhois('peer not found'), null)
  assert.equal(loginFromWhois(''), null)
})

test('whoisFromJson: ログイン名・タグ・端末の名前・最上段の CapMap（grants で与えた capability）を読む', () => {
  const json = JSON.stringify({
    Node: { Name: 'ci-runner.example.ts.net.', Tags: ['tag:ci'], CapMap: { 'node-attr': null } },
    UserProfile: { LoginName: 'tagged-devices' },
    CapMap: { 'example.com/cap/x': [{ tools: ['read'] }], broken: 'x' },
  })
  assert.deepEqual(whoisFromJson(json), { login: 'tagged-devices', tagged: true, node: 'ci-runner', caps: { 'example.com/cap/x': [{ tools: ['read'] }], broken: [] } }, 'Node.CapMap（端末の属性）ではなく最上段を読む')
  assert.deepEqual(whoisFromJson(JSON.stringify({ Node: { Name: 'mac.example.ts.net.' }, UserProfile: { LoginName: 'me@example.com' }, CapMap: null })), {
    login: 'me@example.com',
    tagged: false,
    node: 'mac',
    caps: {},
  })
  assert.equal(whoisFromJson(JSON.stringify({ Node: { Tags: [] } })), null, 'ログイン名もタグも無い')
})

test('tailscaleBins: PATH の tailscale、macOS はその後に GUI 版（SAI_TAILSCALE_BIN は無い。#288）', () => {
  assert.deepEqual(tailscaleBins('darwin'), ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'])
  assert.deepEqual(tailscaleBins('linux'), ['tailscale'])
})

test('identify: ヘッダがどちらも無ければ、ループバックからだけ通す', async () => {
  const auth = new Authenticator(async () => user('x@example.com'))
  assert.deepEqual(await auth.identify(req({})), { kind: 'local' })
  assert.deepEqual(await auth.identify(req({}, '::1')), { kind: 'local' })
  assert.equal(await auth.identify(req({}, '10.0.0.5')), null)
  assert.equal(auth.calls, 0, 'whois は呼ばない')
})

test('identify: Serve を通ったのにユーザーのヘッダが無い（X-Forwarded-For だけ）ものはローカルにしない。タグ付きの端末なら tagged、それ以外は 401（#312）', async () => {
  const table: Record<string, WhoisInfo | null> = { '100.64.0.7': tagged({ 'example.com/cap/x': [{}] }), '100.64.0.1': user('me@example.com') }
  const auth = new Authenticator(async (addr) => table[addr] ?? null)
  assert.deepEqual(await auth.identify(req({ 'x-forwarded-for': '100.64.0.7' })), { kind: 'tagged', node: 'ci', caps: { 'example.com/cap/x': [{}] } })
  assert.equal(await auth.identify(req({ 'x-forwarded-for': '100.64.0.1' })), null, 'ユーザーの端末なのにヘッダが無い（Serve ではない何か）')
  assert.equal(await auth.identify(req({ 'x-forwarded-for': '100.64.0.9' })), null, 'whois で引けない')
  assert.equal(await auth.identify(req({ 'x-forwarded-for': '100.64.0.7' }, '10.0.0.5')), null, 'ループバックでなければ Serve からでもない')
})

test('identify: ヘッダは whois と一致したときだけ信用する（大文字小文字は無視）。タグ付きの端末がログイン名を名乗っても通さない', async () => {
  const caps = { 'example.com/cap/x': [{ tools: ['send'] }] }
  const table: Record<string, WhoisInfo | null> = { '100.64.0.1': user('me@example.com', caps), '100.64.0.2': user('other@example.com'), '100.64.0.3': null, '100.64.0.7': tagged() }
  const auth = new Authenticator(async (addr) => table[addr] ?? null)
  const ok = { 'tailscale-user-login': 'Me@Example.com', 'tailscale-user-name': 'Me', 'x-forwarded-for': '100.64.0.1' }
  assert.deepEqual(await auth.identify(req(ok)), { kind: 'tailnet', login: 'Me@Example.com', name: 'Me', caps }, 'capability も載せる')
  assert.equal(await auth.identify(req({ 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.64.0.2' })), null, 'whois が別人')
  assert.equal(await auth.identify(req({ 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.64.0.3' })), null, 'whois で引けない')
  assert.equal(await auth.identify(req({ 'tailscale-user-login': 'me@example.com' })), null, 'X-Forwarded-For が無ければ確かめようがない')
  assert.equal(await auth.identify(req({ 'tailscale-user-login': 'tagged-devices', 'x-forwarded-for': '100.64.0.7' })), null, 'タグ付きの端末はユーザーではない')
  assert.deepEqual(await auth.identify(req({ 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.64.0.1, 10.0.0.9' })), { kind: 'tailnet', login: 'me@example.com', caps }, '先頭のアドレスを使う')
})

test('identify: whois の結果はアドレスごとにキャッシュする。引けなかったときは短く', async () => {
  let now = 1_000_000
  const realNow = Date.now
  Date.now = () => now
  try {
    const auth = new Authenticator(async (addr) => (addr === '100.64.0.1' ? user('me@example.com') : null), 30_000)
    const ok = { 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.64.0.1' }
    await auth.identify(req(ok))
    await auth.identify(req(ok))
    assert.equal(auth.calls, 1, '30 秒以内は 1 回')
    now += 31_000
    await auth.identify(req(ok))
    assert.equal(auth.calls, 2, '期限が切れたら引き直す')
    const ng = { 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.64.0.9' }
    await auth.identify(req(ng))
    await auth.identify(req(ng))
    assert.equal(auth.calls, 3, '引けなかった結果も覚える')
    now += 6_000
    await auth.identify(req(ng))
    assert.equal(auth.calls, 4, 'ただし 5 秒だけ')
  } finally {
    Date.now = realNow
  }
})
