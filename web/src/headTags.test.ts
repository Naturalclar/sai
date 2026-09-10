import { test } from 'node:test'
import assert from 'node:assert/strict'
import { headName, headTags } from './headTags.ts'
import type { HeadTag, HeadTagInput, HeadTagSession } from './headTags.ts'

const base: HeadTagSession = { host: 'mini', session_source: 'payload', terminal: null, waiting: '', archived: false, permission_mode: '' }
const wide: HeadTagInput = { serverHost: 'mini', approval: '', replyingSince: '', compact: false }
const compact: HeadTagInput = { ...wide, compact: true }
const kinds = (tags: HeadTag[]) => tags.map((t) => t.kind)

test('素の出どころ（payload / rollout）は狭い画面の 1 行目でだけ落とす', () => {
  for (const source of ['payload', 'rollout'] as const) {
    assert.deepEqual(kinds(headTags({ ...base, session_source: source }, wide)), ['source'])
    assert.deepEqual(kinds(headTags({ ...base, session_source: source }, compact)), [], `${source} は 1 行目に出さない`)
  }
})

test('合成（synth）は返信できない理由なので、1 行目にも残す', () => {
  assert.deepEqual(kinds(headTags({ ...base, session_source: 'synth' }, compact)), ['synth'])
})

test('出どころが空なら空の印を出さない', () => {
  assert.deepEqual(kinds(headTags({ ...base, session_source: '' }, wide)), [])
})

test('許可モード: default と空は出さず、それ以外は 1 行目にも出す（素通しを落とさない。#253）', () => {
  assert.deepEqual(kinds(headTags({ ...base, permission_mode: 'default' }, compact)), [])
  assert.deepEqual(kinds(headTags({ ...base, permission_mode: '' }, compact)), [])
  for (const mode of ['acceptEdits', 'auto', 'bypassPermissions']) {
    assert.deepEqual(headTags({ ...base, permission_mode: mode }, compact), [{ kind: 'mode', mode }], `${mode} は 1 行目にも出す`)
  }
})

test('状態の印は 1 行目にも全部出し、並びは広い画面の見出しと同じ', () => {
  const all: HeadTagSession = {
    host: 'other',
    session_source: 'payload',
    terminal: { pane: '%1', pid: 42 },
    waiting: '許可待ち: Bash: ls',
    archived: true,
    permission_mode: 'bypassPermissions',
  }
  const input = { serverHost: 'mini', approval: '許可待ち: Edit', replyingSince: '2026-09-10T00:00:00Z' }
  assert.deepEqual(kinds(headTags(all, { ...input, compact: false })), ['host', 'source', 'terminal', 'waiting', 'approval', 'replying', 'archived', 'mode'])
  assert.deepEqual(kinds(headTags(all, { ...input, compact: true })), ['host', 'terminal', 'waiting', 'approval', 'replying', 'archived', 'mode'], '1 行目で落ちるのは出どころだけ')
})

test('別のマシンの印はサーバと違うときだけ（サーバの名前が取れないときは出さない）', () => {
  assert.deepEqual(kinds(headTags({ ...base, host: 'other' }, compact)), ['host'])
  assert.deepEqual(kinds(headTags({ ...base, host: 'other' }, { ...compact, serverHost: '' })), [])
})

test('headName: 表示名があればそれと #project、無ければ project だけ。project が分からなければ repo', () => {
  assert.deepEqual(headName({ project: 'Naturalclar/sai', repo: 'dev-kanade', meta: { name: 'かなで' } }), { name: 'かなで', project: 'sai' })
  assert.deepEqual(headName({ project: 'Naturalclar/sai', repo: 'dev-kanade', meta: undefined }), { name: '', project: 'sai' })
  assert.deepEqual(headName({ project: '', repo: 'dev-kanade', meta: {} }), { name: '', project: 'dev-kanade' })
})
