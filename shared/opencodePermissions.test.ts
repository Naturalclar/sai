import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NO_PENDING, OPENCODE_DECISIONS, opencodePermissionText, parsePermissions, permissionApprovalId, permissionApprovals, permissionDetail, permissionResponse, settlesWaiting } from './opencodePermissions.ts'
import type { PendingSnapshot } from './opencodePermissions.ts'

/**
 * 実機（opencode 1.18.30）の `GET /permission` の 1 件。ollama/qwen3:8b のターンに `/etc/hosts` を読ませて出したもの。
 * **`feed/opencode/sai.js` に同じ payload を流すテスト（server/opencodePlugin.test.ts）と、同じ期待文字列**を置いてある
 */
export const REAL_PERMISSION = {
  id: 'per_0a8ae76cb001yE6OKiZ7AnqswF',
  sessionID: 'ses_f5752e6b4ffe1aA7qYuNMKzXC9',
  permission: 'external_directory',
  patterns: ['/etc/*'],
  metadata: { filepath: '/etc/hosts', parentDir: '/etc' },
  always: ['/etc/*'],
  tool: { messageID: 'msg_0a8ad1a2800163HdX1urIWNULb', callID: 'call_atmqta71' },
}

/** 待ちの行に出る文言。プラグイン側のテストと**同じ文字列**（片方だけ変えるともう片方が落ちる） */
export const REAL_PERMISSION_TEXT = '許可待ち: external_directory: /etc/hosts'

test('opencodePermissionText: 実物の metadata から、何を聞かれているかまで出す', () => {
  assert.equal(opencodePermissionText(REAL_PERMISSION), REAL_PERMISSION_TEXT)
})

test('permissionDetail: キーの大文字小文字は無視する（実物は filepath）', () => {
  assert.equal(permissionDetail({ patterns: [], metadata: { filepath: '/etc/hosts' } }), '/etc/hosts')
  assert.equal(permissionDetail({ patterns: [], metadata: { filePath: '/etc/hosts' } }), '/etc/hosts')
  assert.equal(permissionDetail({ patterns: [], metadata: { command: 'ls -la' } }), 'ls -la', 'command が先')
  assert.equal(permissionDetail({ patterns: [], metadata: { command: 'ls -la', filepath: '/x' } }), 'ls -la')
  assert.equal(permissionDetail({ patterns: ['/etc/*'], metadata: {} }), '/etc/*', 'metadata に無ければ patterns')
  assert.equal(permissionDetail({ patterns: [], metadata: {} }), '')
})

test('opencodePermissionText: 詳細が無ければ種類だけ、長ければ切る', () => {
  assert.equal(opencodePermissionText({ permission: 'bash', patterns: [], metadata: {} }), '許可待ち: bash')
  assert.equal(opencodePermissionText({ permission: '', patterns: [], metadata: {} }), '許可待ち: 許可')
  const long = opencodePermissionText({ permission: 'bash', patterns: [], metadata: { command: 'あ'.repeat(500) } })
  assert.equal(Array.from(long).length, 300)
})

test('parsePermissions: 実物を読み、id か sessionID の無いものは落とす', () => {
  const got = parsePermissions([REAL_PERMISSION, { id: 'per_x' }, { sessionID: 'ses_x' }, 'ごみ', null])
  assert.equal(got.length, 1)
  assert.equal(got[0]!.id, 'per_0a8ae76cb001yE6OKiZ7AnqswF')
  assert.equal(got[0]!.permission, 'external_directory')
  assert.deepEqual(got[0]!.patterns, ['/etc/*'])
  assert.equal(parsePermissions({ data: [] }).length, 0, 'v2 の形（配列でない）は読まない')
  assert.equal(parsePermissions(null).length, 0)
})

test('permissionApprovals: 行にあるセッションだけを、答えられるバブルにする', () => {
  const map = permissionApprovals(
    parsePermissions([REAL_PERMISSION, { ...REAL_PERMISSION, id: 'per_2', sessionID: 'ses_知らない' }]),
    (s) => (s === REAL_PERMISSION.sessionID ? 'ses_f5752e6b4ffe1aA7qYuNMKzXC9@dev-oc' : undefined),
    () => '2026-09-16T05:26:43.000Z',
  )
  assert.deepEqual(Object.keys(map), ['ses_f5752e6b4ffe1aA7qYuNMKzXC9@dev-oc'], '記録に無いセッションの保留は出さない')
  const approval = map['ses_f5752e6b4ffe1aA7qYuNMKzXC9@dev-oc']![0]!
  assert.equal(approval.approval_id, permissionApprovalId(REAL_PERMISSION.id))
  assert.equal(approval.text, REAL_PERMISSION_TEXT)
  assert.equal(approval.agent, 'opencode')
  assert.equal(approval.answerable, true)
  assert.deepEqual(approval.decisions?.map((d) => d.id), ['once', 'reject'], '「常に許可」は出さない')
  assert.equal(approval.since, '2026-09-16T05:26:43.000Z')
  assert.deepEqual(approval.input, { filepath: '/etc/hosts', parentDir: '/etc', patterns: ['/etc/*'] })
})

test('permissionResponse: 提示した選択だけを本体に渡す', () => {
  assert.equal(permissionResponse('once', 'allow'), 'once')
  assert.equal(permissionResponse('reject', 'deny'), 'reject')
  assert.equal(permissionResponse('always', 'allow'), null, '出していない「常に許可」は受けない')
  assert.equal(permissionResponse('once', 'deny'), null, 'ボタンと食い違う behavior は受けない')
  assert.equal(permissionResponse(undefined, 'allow'), 'once', '選択を送らない画面でも allow / deny で決まる')
  assert.equal(permissionResponse(undefined, 'deny'), 'reject')
  assert.deepEqual(OPENCODE_DECISIONS.map((d) => d.behavior), ['allow', 'deny'])
})

// ---- settlesWaiting（#422。答える相手が消えた待ちを畳む） ----

const snap = (over: Partial<PendingSnapshot> = {}): PendingSnapshot => ({ ok: true, asked: new Set(['/w']), sessions: new Set(), ...over })
const target = { session: 'ses_1', cwd: '/w' }

test('settlesWaiting: 待ちの行を書いたプロセスが消えていれば畳む', () => {
  assert.equal(settlesWaiting(target, NO_PENDING, false), true, '保留を引けなくても、聞いてきた相手が居なければ畳める')
  assert.equal(settlesWaiting(target, NO_PENDING, true), false, '生きていれば残す（まだ答えられる）')
  assert.equal(settlesWaiting(target, NO_PENDING, undefined), false, 'pid が分からなければ残す')
})

test('settlesWaiting: 保留を引けて、そのセッションが居なければ畳む', () => {
  assert.equal(settlesWaiting(target, snap(), undefined), true)
  assert.equal(settlesWaiting(target, snap({ ok: false }), undefined), false, '引けていなければ（サーバが立っていない）残す')
  assert.equal(settlesWaiting(target, snap({ asked: new Set(['/other']) }), undefined), false, '聞いていない cwd は残す')
  assert.equal(settlesWaiting({ session: 'ses_1', cwd: '' }, snap(), undefined), false, 'cwd が無ければ残す')
})

test('settlesWaiting: いま保留があれば、pid が死んでいても残す', () => {
  const live = snap({ sessions: new Set(['ses_1']) })
  assert.equal(settlesWaiting(target, live, false), false, '古い行の死んだ pid より、いまの保留が正しい')
  assert.equal(settlesWaiting(target, live, true), false)
})
