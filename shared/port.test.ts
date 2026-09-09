import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PORT, parsePort, portFromEnv } from './port.ts'

test('parsePort: 1〜65535 の整数だけ通す', () => {
  assert.equal(parsePort('8787'), 8787)
  assert.equal(parsePort('1'), 1)
  assert.equal(parsePort('65535'), 65535)
  assert.equal(parsePort('0'), null)
  assert.equal(parsePort('65536'), null)
  assert.equal(parsePort('abc'), null)
  assert.equal(parsePort('80.5'), null)
  assert.equal(parsePort('-1'), null)
  assert.equal(parsePort(' 8787'), null, '空白入りは通さない')
  assert.equal(parsePort(''), null)
  assert.equal(parsePort(undefined), null)
})

test('portFromEnv: 未設定は既定。おかしい値は既定に落として invalid に残す', () => {
  assert.deepEqual(portFromEnv('9000'), { port: 9000 })
  assert.deepEqual(portFromEnv(undefined), { port: DEFAULT_PORT })
  assert.deepEqual(portFromEnv(''), { port: DEFAULT_PORT }, '空は未設定と同じ（invalid にしない）')
  assert.deepEqual(portFromEnv('abc'), { port: DEFAULT_PORT, invalid: 'abc' })
  assert.deepEqual(portFromEnv('70000'), { port: DEFAULT_PORT, invalid: '70000' })
})
