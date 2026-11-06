// webhook の署名と送り先の検査（#873）。名前を引く口は偽物で、外には繋がない
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { isPrivateAddress, resolveCallback, secretBytes, signWebhook } from './webhook.ts'

const KEY_A = `whsec_${Buffer.from('a'.repeat(24)).toString('base64')}`
const KEY_B = `whsec_${Buffer.from('b'.repeat(24)).toString('base64')}`

test('署名は Standard Webhooks の形。鍵が 2 つなら 2 つ並び、どちらでも確かめられる', () => {
  const sig = signWebhook([KEY_A, KEY_B], 'msg_1', 1700000000, '{"x":1}')
  const parts = sig.split(' ')
  assert.equal(parts.length, 2)
  for (const [i, key] of [KEY_A, KEY_B].entries()) {
    const want = createHmac('sha256', secretBytes(key)!).update('msg_1.1700000000.{"x":1}').digest('base64')
    assert.equal(parts[i], `v1,${want}`)
  }
  // 形の違う鍵は使わない
  assert.equal(signWebhook(['nope', 'whsec_'], 'm', 1, ''), '')
})

test('private・ループバック・リンクローカル・CGNAT・埋め込んだ IPv4 は外の送り先にしない', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '64:ff9b::a00:1', '2002::1', 'not-an-ip']) {
    assert.equal(isPrivateAddress(ip), true, ip)
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(ip), false, ip)
})

test('callback は https で、引いた先が全部 public のときだけ。1 つでも private なら送らない', async () => {
  const lookup = async (host: string) => ({ 'ok.example': ['8.8.8.8'], 'mixed.example': ['8.8.8.8', '10.0.0.2'], 'none.example': [] })[host] ?? Promise.reject(new Error('NXDOMAIN'))
  const ok = await resolveCallback('https://ok.example/hook', lookup)
  assert.equal(typeof ok, 'object')
  assert.equal(typeof ok === 'object' && ok.address, '8.8.8.8')
  assert.match(String(await resolveCallback('http://ok.example/hook', lookup)), /https/)
  assert.match(String(await resolveCallback('https://mixed.example/hook', lookup)), /private/)
  assert.match(String(await resolveCallback('https://[::ffff:127.0.0.1]/hook', lookup)), /private/)
  assert.match(String(await resolveCallback('https://127.0.0.1/hook', lookup)), /private/)
  assert.match(String(await resolveCallback('https://none.example/hook', lookup)), /引けません/)
  assert.match(String(await resolveCallback('https://gone.example/hook', lookup)), /引けません/)
  assert.match(String(await resolveCallback('https://u:p@ok.example/hook', lookup)), /パスワード/)
})
