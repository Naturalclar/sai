import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventKind } from './events.ts'

test('eventKind: ターン完了は名指し（Claude の Stop、Codex の agent-turn-complete）', () => {
  assert.equal(eventKind('Stop'), 'turn')
  assert.equal(eventKind('agent-turn-complete'), 'turn')
})

test('eventKind: OpenCode のイベント名（プラグインが載せる。#209）', () => {
  assert.equal(eventKind('session.idle'), 'turn')
  assert.equal(eventKind('permission.asked'), 'waiting')
  assert.equal(eventKind('permission.replied'), 'resume')
  // 名前は OpenCode のイベント名そのままなので、渡していないものは other のまま
  assert.equal(eventKind('session.updated'), 'other')
  assert.equal(eventKind('message.part.updated'), 'other')
})

test('eventKind: unknown と空も turn（record.py の detect_event が今も返す）', () => {
  // hook_event_name も type も無いペイロードで detect_event() が返す値。古い行だけの話ではない
  assert.equal(eventKind('unknown'), 'turn')
  assert.equal(eventKind(''), 'turn')
  assert.equal(eventKind(undefined), 'turn')
})

test('eventKind: 人を待って止まった行', () => {
  assert.equal(eventKind('PermissionRequest'), 'waiting')
  assert.equal(eventKind('PreToolUse'), 'waiting')
  assert.equal(eventKind('Notification'), 'waiting')
})

test('eventKind: 人が入力した行', () => {
  assert.equal(eventKind('UserPromptSubmit'), 'resume')
})

/**
 * この 1 件が #235 の本体。以前は既定が turn だったので、ここに挙げた値が全部 turn になり、
 * 本文の無い行が「一番新しいターン完了」を奪っていた
 */
test('eventKind: 知らない event は other（turn に落とさない。#235）', () => {
  // Claude のフック名。record.py を向ければそのまま行になる
  for (const e of ['SubagentStop', 'PreCompact', 'SessionStart', 'SessionEnd', 'PostToolUse']) {
    assert.equal(eventKind(e), 'other', e)
  }
  // Codex の notify の type。README のラッパーは "$@" をそのまま渡す
  for (const e of ['session-configured', 'task-started', 'task-complete']) {
    assert.equal(eventKind(e), 'other', e)
  }
  // 将来のエージェント（#192）で増える分もここに落ちる
  assert.equal(eventKind('gemini-turn-done'), 'other')
  assert.equal(eventKind('  Stop  '), 'other', '前後の空白は詰めない（record.py は詰めて書く）')
  assert.equal(eventKind('stop'), 'other', '大文字小文字は区別する')
})
