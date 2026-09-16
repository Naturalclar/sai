import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionSummary } from '../../shared/types.ts'
import { approvalMapKey, CodexDialogs, mergeApprovalMaps } from './codexDialogs.ts'
import type { Tmux } from './terminal.ts'

class FakeTmux implements Tmux {
  screen = '› 1. Yes\n  2. No\nEnter to confirm · Esc to cancel'
  panePid = '100\n'
  /** 送られたキー（#450）。`send-keys` 1 回ぶんを 1 要素にまとめる */
  keys: string[] = []
  /** キーを送ったあとに差し替わる画面（実機の「動いた」「消えた」の代わり） */
  onKeys: ((keys: string[]) => void) | null = null
  async run(args: string[]): Promise<string> {
    if (args[0] === 'display-message') return this.panePid
    if (args[0] === 'capture-pane') return this.screen
    if (args[0] === 'send-keys') {
      const sent = args.slice(3)
      this.keys.push(sent.join(' '))
      this.onKeys?.(sent)
      return ''
    }
    throw new Error(`unexpected tmux call: ${args.join(' ')}`)
  }
}

const session = (agent: 'codex' | 'claude' = 'codex') =>
  ({ id: 'T1@repo', agent, terminal: { pane: '%9', pid: 200 } }) as SessionSummary

test('CodexDialogs: 同じpidのCodexペインがダイアログ中なら検出専用Approvalを出し、消えたら片付ける', async () => {
  const tmux = new FakeTmux()
  let now = Date.parse('2026-09-09T12:00:00+09:00')
  const dialogs = new CodexDialogs(tmux, async () => '200 100\n100 1\n', () => now)

  const waiting = await dialogs.scan([session()])
  assert.equal(waiting['T1@repo']?.[0]?.text, 'Codex の画面で質問または許可への回答を待っている')
  assert.equal(waiting['T1@repo']?.[0]?.agent, 'codex')
  assert.equal(waiting['T1@repo']?.[0]?.answerable, true, '選択肢が読めていれば画面から答えられる（#450）')
  assert.equal(waiting['T1@repo']?.[0]?.since, '2026-09-09T03:00:00.000Z')

  now += 10_000
  assert.equal((await dialogs.scan([session()]))['T1@repo']?.[0]?.since, '2026-09-09T03:00:00.000Z', '待機中は開始時刻を保つ')
  tmux.screen = 'done\n› Ask Codex to do anything\n  gpt-5.6-sol medium · /work'
  assert.deepEqual(await dialogs.scan([session()]), {})
})

test('CodexDialogs: pid不一致・Claude・ペイン消滅は待機と断定しない', async () => {
  const tmux = new FakeTmux()
  const mismatch = new CodexDialogs(tmux, async () => '999 100\n100 1\n')
  assert.deepEqual(await mismatch.scan([session()]), {})
  assert.deepEqual(await mismatch.scan([session('claude')]), {})
  tmux.panePid = ''
  assert.deepEqual(await mismatch.scan([session()]), {})
})

test('mergeApprovalMaps / approvalMapKey: ClaudeとCodexを時刻順に重ね、順序に依らない鍵を作る', () => {
  const codex = { approval_id: 'x', id: 'T@r', since: '2026-09-09T02:00:00Z', tool_name: 'CodexDialog', input: {}, tool_use_id: '', text: 'codex' }
  const claude = { approval_id: 'c', id: 'T@r', since: '2026-09-09T01:00:00Z', tool_name: 'Bash', input: {}, tool_use_id: '', text: 'claude' }
  const merged = mergeApprovalMaps({ 'T@r': [codex] }, { 'T@r': [claude] })
  assert.deepEqual(merged['T@r']?.map((a) => a.approval_id), ['c', 'x'])
  assert.equal(approvalMapKey(merged), 'c,x')
  assert.equal(approvalMapKey({ 'T@r': [codex, claude] }), 'c,x')
})

/** 実機の形（codex 0.154.0）。会話の行は字下げが無く、ダイアログは 2 文字下げ */
const askScreen = (command: string) =>
  [
    '⚠ MCP startup incomplete (failed: linear)',
    '',
    '  Would you like to run the following command?',
    '',
    `  $ ${command}`,
    '',
    '› 1. Yes, proceed (y)',
    '  2. No, and tell Codex what to do differently (esc)',
    '',
    '  Press enter to confirm or esc to cancel',
  ].join('\n')

test('CodexDialogs: 画面から読んだ選択肢を Approval に載せる（#425）', async () => {
  const tmux = new FakeTmux()
  tmux.screen = askScreen('git add -A')
  const dialogs = new CodexDialogs(tmux, async () => '200 100\n100 1\n', () => Date.parse('2026-09-16T12:00:00+09:00'))

  const approval = (await dialogs.scan([session()]))['T1@repo']?.[0]
  assert.equal(approval?.text, 'Codex の許可待ち: git add -A', '一覧の 1 行も中身にする')
  assert.equal(approval?.answerable, true, '選択肢が読めたので画面から答えられる（#450）')
  assert.deepEqual(approval?.decisions?.map((d) => d.id), ['opt-1', 'opt-2'], 'そのまま押せる選択肢だけ')
  assert.equal(approval?.dialog?.title, 'Would you like to run the following command?')
  assert.equal(approval?.dialog?.command, 'git add -A')
  assert.deepEqual(approval?.dialog?.options.map((o) => `${o.number}${o.selected ? '*' : ''}`), ['1*', '2'])
})

test('CodexDialogs: 次の許可に変わったら別の待ちにする（鍵が変わらないと画面が拾えない）', async () => {
  const tmux = new FakeTmux()
  tmux.screen = askScreen('git add -A')
  let now = Date.parse('2026-09-16T12:00:00+09:00')
  const dialogs = new CodexDialogs(tmux, async () => '200 100\n100 1\n', () => now)
  const first = (await dialogs.scan([session()]))['T1@repo']?.[0]

  now += 10_000
  tmux.screen = tmux.screen.replace('› 1.', '  1.').replace('  2.', '› 2.')
  const moved = (await dialogs.scan([session()]))['T1@repo']?.[0]
  assert.equal(moved?.approval_id, first?.approval_id, 'カーソルが動いただけなら同じ待ち')
  assert.equal(moved?.since, first?.since, '待ち始めた時刻も戻さない')

  now += 10_000
  tmux.screen = askScreen('git commit -m wip')
  const next = (await dialogs.scan([session()]))['T1@repo']?.[0]
  assert.notEqual(next?.approval_id, first?.approval_id, '中身が変われば別の approval_id')
  assert.equal(next?.since, '2026-09-16T03:00:20.000Z', '新しく待ち始めた時刻')
  assert.equal(next?.dialog?.command, 'git commit -m wip')
})

// ---- 画面から答える（#450） ----

/** 3 つの選択肢（実機と同じ並び。2 つめは「今後も確認しない」） */
const threeScreen = (mark = 1) =>
  [
    '  Would you like to run the following command?',
    '',
    '  $ git add -A',
    '',
    `${mark === 1 ? '›' : ' '} 1. Yes, proceed (y)`,
    `${mark === 2 ? '›' : ' '} 2. Yes, and don't ask again for commands that start with \`git add\` (p)`,
    `${mark === 3 ? '›' : ' '} 3. No, and tell Codex what to do differently (esc)`,
    '',
    '  Press enter to confirm or esc to cancel',
  ].join('\n')

const IDLE = '• done\n› Ask Codex to do anything\n  gpt-5.6-sol medium · /work'

async function ready(tmux: FakeTmux): Promise<{ dialogs: CodexDialogs; approvalId: string }> {
  const dialogs = new CodexDialogs(tmux, async () => '200 100\n100 1\n', () => Date.parse('2026-09-16T12:00:00+09:00'), 0)
  const approval = (await dialogs.scan([session()]))['T1@repo']?.[0]
  assert.ok(approval, 'ダイアログが出ている')
  return { dialogs, approvalId: approval.approval_id }
}

test('answer: 印をその選択肢まで動かして Enter を送る（数字キーは使わない）', async () => {
  const tmux = new FakeTmux()
  tmux.screen = threeScreen(1)
  const { dialogs, approvalId } = await ready(tmux)
  // 矢印で動いたら画面も動く。Enter でダイアログが消える
  tmux.onKeys = (keys) => {
    if (keys[0] === 'Enter') tmux.screen = IDLE
    else if (keys[0] === 'Down') tmux.screen = threeScreen(1 + keys.length)
  }
  assert.deepEqual(await dialogs.answer(approvalId, { behavior: 'deny', decision: 'opt-3' }), { ok: true })
  assert.deepEqual(tmux.keys, ['Down Down', 'Enter'], '2 つ下げてから確定')
  assert.equal(dialogs.has(approvalId), false, '答えたぶんは消える')
})

test('answer: いま印が付いている選択肢なら矢印は送らない', async () => {
  const tmux = new FakeTmux()
  tmux.screen = threeScreen(1)
  const { dialogs, approvalId } = await ready(tmux)
  tmux.onKeys = () => { tmux.screen = IDLE }
  assert.deepEqual(await dialogs.answer(approvalId, { behavior: 'allow', decision: 'opt-1' }), { ok: true })
  assert.deepEqual(tmux.keys, ['Enter'])
})

test('answer: 送る前に画面が変わっていたら、何も送らない（#208 の誤承認を避ける歯止め）', async () => {
  const tmux = new FakeTmux()
  tmux.screen = threeScreen(1)
  const { dialogs, approvalId } = await ready(tmux)
  // 人が端末で答えて、次の許可に入れ替わった
  tmux.screen = threeScreen(1).replace('git add -A', 'git push origin main')
  const result = await dialogs.answer(approvalId, { behavior: 'allow', decision: 'opt-1' })
  assert.deepEqual(result, { ok: false, status: 409, error: '画面が変わりました（もう一度確かめてください）' })
  assert.deepEqual(tmux.keys, [], 'キーを 1 つも送らない')

  // ダイアログそのものが消えていた場合も同じ
  tmux.screen = IDLE
  assert.equal((await dialogs.answer(approvalId, { behavior: 'allow', decision: 'opt-1' }) as { status: number }).status, 409)
  assert.deepEqual(tmux.keys, [])
})

test('answer: 動かしても印が狙った所に来なければ Enter を送らない', async () => {
  const tmux = new FakeTmux()
  tmux.screen = threeScreen(1)
  const { dialogs, approvalId } = await ready(tmux)
  // 矢印が効かない端末（画面が変わらない）
  tmux.onKeys = () => {}
  const result = await dialogs.answer(approvalId, { behavior: 'deny', decision: 'opt-3' })
  assert.deepEqual(result, { ok: false, status: 409, error: '選び直せませんでした（端末で答えてください）' })
  assert.deepEqual(tmux.keys, ['Down Down'], 'Enter は送っていない')
})

test('answer: Enter のあともダイアログが残っていたら、押せたことにしない', async () => {
  const tmux = new FakeTmux()
  tmux.screen = threeScreen(1)
  const { dialogs, approvalId } = await ready(tmux)
  tmux.onKeys = () => {} // Enter が効かない
  const result = await dialogs.answer(approvalId, { behavior: 'allow', decision: 'opt-1' })
  assert.deepEqual(result, { ok: false, status: 409, error: '答えが届きませんでした（端末で答えてください）' })
  assert.deepEqual(tmux.keys, ['Enter'], '押し直さない')
  assert.equal(dialogs.has(approvalId), true, 'バブルは残す（まだ答えられていない）')
})

test('answer: 出していない選択肢（今後も確認しない）と、知らない approval は受けない', async () => {
  const tmux = new FakeTmux()
  tmux.screen = threeScreen(1)
  const { dialogs, approvalId } = await ready(tmux)
  assert.deepEqual(await dialogs.answer(approvalId, { behavior: 'allow', decision: 'opt-2' }), { ok: false, status: 400, error: '提示されていない選択です' })
  assert.deepEqual(await dialogs.answer(approvalId, { behavior: 'deny', decision: 'opt-1' }), { ok: false, status: 400, error: '提示されていない選択です' })
  assert.deepEqual(await dialogs.answer('codex-dialog-知らない', { behavior: 'allow', decision: 'opt-1' }), { ok: false, status: 404, error: 'approval not found' })
  assert.deepEqual(tmux.keys, [], 'どれもキーを送らない')
})

test('answer: 中身が読めていないダイアログは端末に任せる', async () => {
  const tmux = new FakeTmux()
  // 選択肢が 1 つも無い画面（`promptState` はダイアログと見るが `parseCodexDialog` は読めない）
  tmux.screen = '  Waiting for user input\n  何か聞かれているが形が違う'
  const dialogs = new CodexDialogs(tmux, async () => '200 100\n100 1\n', () => Date.parse('2026-09-16T12:00:00+09:00'), 0)
  const approval = (await dialogs.scan([session()]))['T1@repo']?.[0]
  assert.equal(approval?.answerable, false)
  assert.equal(approval?.decisions, undefined)
  assert.deepEqual(await dialogs.answer(approval!.approval_id, { behavior: 'allow', decision: 'opt-1' }), {
    ok: false,
    status: 409,
    error: 'この待ちは端末で答えてください',
  })
})
