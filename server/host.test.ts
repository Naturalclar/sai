import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRemoteHost } from '../shared/host.ts'
import { selfHost } from './host.ts'

const MACHINE = () => 'Jesses-Mac-mini.local'

test('selfHost: AGENT_FEED_HOST があればそれ（record.py の host_name() と同じ短い形）', () => {
  assert.equal(selfHost({ AGENT_FEED_HOST: 'mini' }, MACHINE), 'mini')
  assert.equal(selfHost({ AGENT_FEED_HOST: ' mbp.local ' }, MACHINE), 'mbp', '前後の空白と . から先を落とす')
})

test('selfHost: 無ければ・空白だけなら hostname の短い形', () => {
  assert.equal(selfHost({}, MACHINE), 'Jesses-Mac-mini')
  assert.equal(selfHost({ AGENT_FEED_HOST: '   ' }, MACHINE), 'Jesses-Mac-mini')
})

test('selfHost: hostname も取れなければ空（何もリモートにしない）', () => {
  const broken = () => {
    throw new Error('no hostname')
  }
  assert.equal(selfHost({}, broken), '')
  assert.equal(isRemoteHost('mini', selfHost({}, broken)), false)
})

test('selfHost: SAI_HOST はもう読まない（#288）', () => {
  assert.equal(selfHost({ SAI_HOST: 'mac' }, MACHINE), 'Jesses-Mac-mini')
})

test('記録側と揃う: AGENT_FEED_HOST だけ設定しても、自分の行は「別のマシン」にならない（#288）', () => {
  // README の手順どおりシェルに `export AGENT_FEED_HOST=mini` だけ置いた状態。record.py は行に host: mini を書く。
  // 前はサーバが SAI_HOST（無ければ hostname = Jesses-Mac-mini）を見ていて、自分のセッションがリモートになり返信の口が消えた
  const env = { AGENT_FEED_HOST: 'mini' }
  assert.equal(isRemoteHost('mini', selfHost(env, MACHINE)), false)
  assert.equal(isRemoteHost('air', selfHost(env, MACHINE)), true, 'よそのマシンの行は今までどおりリモート')
})
