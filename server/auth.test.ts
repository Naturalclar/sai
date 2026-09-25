import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Authenticator, WHOIS_RETRY_MS, WHOIS_STALE_MS, WhoisUnavailable, loginFromWhois, tailscaleBins, tailscaleWhois, whoisFromJson } from './auth.ts'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('identify: 同じアドレスの whois は同時に 1 本だけ（画面を開いた瞬間の同時リクエストで CLI を何本も起こさない）', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const auth = new Authenticator(async () => {
    await gate
    return user('me@example.com')
  })
  const ok = { 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.64.0.1' }
  // 一覧・フィード・詳細・手順・アイコン…が一度に来る
  const pending = Array.from({ length: 12 }, () => auth.identify(req(ok)))
  release()
  const got = await Promise.all(pending)
  assert.equal(auth.calls, 1, '12 本のリクエストで whois は 1 回')
  assert.ok(got.every((g) => g?.kind === 'tailnet'), '全部同じ答えで通る')
})

test('identify: whois を聞けなかった（時間切れ）だけなら、直前に確かめた本人をしばらく使い続ける', async () => {
  let now = 1_000_000
  const realNow = Date.now
  Date.now = () => now
  try {
    let mode: 'ok' | 'down' | 'other' = 'ok'
    const auth = new Authenticator(async () => {
      if (mode === 'down') throw new WhoisUnavailable('時間切れ')
      return mode === 'ok' ? user('me@example.com') : user('someone@example.com')
    }, 30_000)
    const ok = { 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.64.0.1' }
    assert.equal((await auth.identify(req(ok)))?.kind, 'tailnet')

    // キャッシュが切れたところで whois が時間切れ。前は null を 5 秒覚えて、その間ずっと 401 だった
    now += 31_000
    mode = 'down'
    assert.equal((await auth.identify(req(ok)))?.kind, 'tailnet', '聞けなかっただけなので、さっきの本人のまま通す')
    const callsAfterFailure = auth.calls
    assert.equal((await auth.identify(req(ok)))?.kind, 'tailnet')
    assert.equal(auth.calls, callsAfterFailure, '失敗も短く覚える（毎リクエスト叩き直さない）')
    now += WHOIS_RETRY_MS + 1
    await auth.identify(req(ok))
    assert.equal(auth.calls, callsAfterFailure + 1, '短く後で聞き直す')

    // ずっと聞けないまま WHOIS_STALE_MS を過ぎたら、もう信用しない
    now = 1_000_000 + WHOIS_STALE_MS + 1
    assert.equal(await auth.identify(req(ok)), null, '確かめてから時間が経ちすぎたら 401')
  } finally {
    Date.now = realNow
  }
})

test('identify: whois が「別人」「居ない」と答えたら、前の本人は捨ててすぐ 401（聞けなかったときとは分ける）', async () => {
  let now = 1_000_000
  const realNow = Date.now
  Date.now = () => now
  try {
    let answer: WhoisInfo | null = user('me@example.com')
    const auth = new Authenticator(async () => answer, 30_000)
    const ok = { 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.64.0.1' }
    assert.equal((await auth.identify(req(ok)))?.kind, 'tailnet')
    now += 31_000
    answer = user('someone@example.com')
    assert.equal(await auth.identify(req(ok)), null, '別人と答えたら通さない')
    now += 31_000
    answer = null
    assert.equal(await auth.identify(req(ok)), null, '居ないと答えたら通さない')
    // 一度「居ない」と答えたあとで聞けなくなっても、前の本人には戻らない
    now += WHOIS_RETRY_MS + 1
    const auth2 = new Authenticator(async () => {
      throw new WhoisUnavailable('時間切れ')
    }, 30_000)
    assert.equal(await auth2.identify(req(ok)), null, '一度も確かめていなければ、聞けないときは 401')
  } finally {
    Date.now = realNow
  }
})

test('tailscaleWhois: 時間切れ・デーモンの失敗は「聞けなかった」、peer not found は「居ない」', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-whois-'))
  const bin = join(dir, 'tailscale')
  const realPath = process.env.PATH
  process.env.PATH = `${dir}:${realPath ?? ''}`
  try {
    // 非 0（デーモンが答えない）
    await writeFile(bin, '#!/bin/sh\necho "failed to connect to local tailscaled" >&2\nexit 1\n')
    await chmod(bin, 0o755)
    await assert.rejects(tailscaleWhois()('100.64.0.1'), WhoisUnavailable)
    // 本物の CLI は peer not found を stderr に出して exit 1（1.85 / 1.102 で実測）→「居ない」。
    // 聞けなかったに混ぜると、tailnet から外した端末が直前の本人のまま通り続ける
    await writeFile(bin, '#!/bin/sh\necho "2026/09/25 13:25:50 peer not found" >&2\nexit 1\n')
    assert.equal(await tailscaleWhois()('100.64.0.1'), null)
    // exit 0 で読めない出力も「居ない」
    await writeFile(bin, '#!/bin/sh\necho "peer not found" >&2\nexit 0\n')
    assert.equal(await tailscaleWhois()('100.64.0.1'), null)
    // 答えられた
    await writeFile(bin, `#!/bin/sh\necho '${JSON.stringify({ UserProfile: { LoginName: 'me@example.com' }, Node: { Name: 'pad.tailnet.ts.net.' } })}'\n`)
    assert.equal((await tailscaleWhois()('100.64.0.1'))?.login, 'me@example.com')
  } finally {
    process.env.PATH = realPath
  }
})
