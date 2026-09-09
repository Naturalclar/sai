import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRemoteHost, shortHost } from './host.ts'

test('shortHost: 前後の空白とドメイン部分を落とす（record.py の host_name と同じ規則）', () => {
  assert.equal(shortHost('  mac-mini  '), 'mac-mini')
  assert.equal(shortHost('mbp.local'), 'mbp')
  assert.equal(shortHost('host.taild2a5cb.ts.net'), 'host')
  assert.equal(shortHost(''), '')
  assert.equal(shortHost('   '), '')
  assert.equal(shortHost('a'.repeat(100)).length, 64, '64 文字で切る')
})

test('isRemoteHost: 名前が違うときだけリモート', () => {
  assert.equal(isRemoteHost('mini', 'mac'), true)
  assert.equal(isRemoteHost('mac', 'mac'), false)
  // 記録側は短い形で書くが、サーバの hostname が FQDN でもここで揃う
  assert.equal(isRemoteHost('mac', 'mac.local'), false)
  assert.equal(isRemoteHost(' mac ', 'mac'), false)
})

test('isRemoteHost: 材料が無いときはリモートにしない', () => {
  // host を載せない古い record.py の行。今までどおり返信できてほしい
  assert.equal(isRemoteHost('', 'mac'), false)
  assert.equal(isRemoteHost(undefined, 'mac'), false)
  // サーバが自分の名前を決められなかった。ここで全部をリモートにすると 1 台の人が返信できなくなる
  assert.equal(isRemoteHost('mini', ''), false)
  assert.equal(isRemoteHost('', ''), false)
})
