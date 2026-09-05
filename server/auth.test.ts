import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Authenticator, loginFromWhois, tailscaleBins } from './auth.ts'
import type { IncomingMessage } from 'node:http'

/** ヘッダと接続元だけを持つ偽の IncomingMessage */
function req(headers: Record<string, string>, remote = '127.0.0.1'): IncomingMessage {
  return { headers, socket: { remoteAddress: remote } } as unknown as IncomingMessage
}

test('loginFromWhois: UserProfile.LoginName を取る。形が違えば null', () => {
  assert.equal(loginFromWhois(JSON.stringify({ Node: {}, UserProfile: { LoginName: 'a@example.com' } })), 'a@example.com')
  assert.equal(loginFromWhois(JSON.stringify({ Node: {} })), null)
  assert.equal(loginFromWhois(JSON.stringify({ UserProfile: { LoginName: 1 } })), null)
  assert.equal(loginFromWhois('peer not found'), null)
  assert.equal(loginFromWhois(''), null)
})

test('tailscaleBins: SAI_TAILSCALE_BIN があればそれだけ、無ければ PATH（macOS は GUI 版も）', () => {
  assert.deepEqual(tailscaleBins({ SAI_TAILSCALE_BIN: '/opt/ts' }), ['/opt/ts'])
  const bins = tailscaleBins({})
  assert.equal(bins[0], 'tailscale')
  if (process.platform === 'darwin') assert.equal(bins[1], '/Applications/Tailscale.app/Contents/MacOS/Tailscale')
})

test('identify: ヘッダ無しはループバックからだけ通す', async () => {
  const auth = new Authenticator(async () => 'x@example.com')
  assert.deepEqual(await auth.identify(req({})), { kind: 'local' })
  assert.deepEqual(await auth.identify(req({}, '::1')), { kind: 'local' })
  assert.equal(await auth.identify(req({}, '10.0.0.5')), null)
  assert.equal(auth.calls, 0, 'whois は呼ばない')
})

test('identify: ヘッダは whois と一致したときだけ信用する（大文字小文字は無視）', async () => {
  const table: Record<string, string | null> = { '100.64.0.1': 'me@example.com', '100.64.0.2': 'other@example.com', '100.64.0.3': null }
  const auth = new Authenticator(async (addr) => table[addr] ?? null)
  const ok = { 'tailscale-user-login': 'Me@Example.com', 'tailscale-user-name': 'Me', 'x-forwarded-for': '100.64.0.1' }
  assert.deepEqual(await auth.identify(req(ok)), { kind: 'tailnet', login: 'Me@Example.com', name: 'Me' })
  assert.equal(await auth.identify(req({ 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.64.0.2' })), null, 'whois が別人')
  assert.equal(await auth.identify(req({ 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.64.0.3' })), null, 'whois で引けない')
  assert.equal(await auth.identify(req({ 'tailscale-user-login': 'me@example.com' })), null, 'X-Forwarded-For が無ければ確かめようがない')
  assert.deepEqual(await auth.identify(req({ 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.64.0.1, 10.0.0.9' })), { kind: 'tailnet', login: 'me@example.com' }, '先頭のアドレスを使う')
})

test('identify: whois の結果はアドレスごとにキャッシュする。引けなかったときは短く', async () => {
  let now = 1_000_000
  const realNow = Date.now
  Date.now = () => now
  try {
    const auth = new Authenticator(async (addr) => (addr === '100.64.0.1' ? 'me@example.com' : null), 30_000)
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
