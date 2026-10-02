import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedRow } from '../../shared/types.ts'
import { groupRows, groupSpeaker, promptArrived, speakerLabel, toUtterances } from './chatGroups.ts'
import { withHandedReplies } from '../../shared/agentMessages.ts'
import { loopPrompt } from '../../shared/loops.ts'
import { entityId } from '../../shared/entity.ts'

// 時刻は Asia/Tokyo 固定のプロセスに依存しないよう、同じ日の中で分だけ動かす
const base = new Date('2026-09-02T03:00:00Z')
const at = (min: number) => new Date(base.getTime() + min * 60_000).toISOString()

function row(min: number, over: Partial<FeedRow> = {}): FeedRow {
  return { ts: at(min), agent: 'claude', repo: 'sai', branch: 'main', session: 's1', session_source: 'payload', cwd: '/x', event: 'Stop', text: '返答', ...over }
}

test('user_text があれば「自分」の発言が先に立ち、無ければエージェントの発言だけ', () => {
  const [mine, theirs] = toUtterances([row(0, { user_text: '頼み' })])
  assert.equal(mine?.speaker, 'me')
  assert.equal(mine?.text, '頼み')
  assert.equal(theirs?.speaker, 'claude')
  assert.equal(theirs?.text, '返答')

  const only = toUtterances([row(0), row(1, { user_text: '   ' })])
  assert.deepEqual(only.map((u) => u.speaker), ['claude', 'claude'])
})

test('thinking はエージェントの発言にだけ載り、空なら載らない', () => {
  const [mine, theirs] = toUtterances([row(0, { user_text: '頼み', thinking: 'まず調べる' })])
  assert.equal(mine?.thinking, undefined)
  assert.equal(theirs?.thinking, 'まず調べる')
  const [plain] = toUtterances([row(1, { thinking: '   ' })])
  assert.equal(plain?.thinking, undefined)
  const [waiting] = toUtterances([row(2, { event: 'PermissionRequest', text: '許可待ち: Bash', thinking: 'x' })])
  assert.equal(waiting?.thinking, undefined, '待ちの行には付けない')
})

test('model は前のターンから変わったバブルにだけ載る（最初のターンや同じモデルの続きには載らない）', () => {
  const us = toUtterances([
    row(0, { model: 'claude-fable-5' }),
    row(1, { model: 'claude-fable-5' }),
    row(2, { model: 'claude-opus-5' }),
    row(3),
    row(4, { model: 'claude-opus-5' }),
    row(5, { model: 'claude-fable-5', session: 's2' }),
  ])
  assert.deepEqual(us.map((u) => u.model ?? ''), ['', '', 'claude-opus-5', '', '', ''], '別のセッションの最初のターンにも出さない')
})

test('同じ発言者が10分以内に続けば1つのグループ、10分空けば別のグループ', () => {
  const days = groupRows([row(0), row(9), row(19)])
  assert.equal(days.length, 1)
  const groups = days[0]!.groups
  assert.equal(groups.length, 2)
  assert.equal(groups[0]!.items.length, 2)
  assert.equal(groups[0]!.lastTs, at(9))
  assert.equal(groups[1]!.firstTs, at(19))
})

test('発言者かセッションが変わればグループを切る', () => {
  const days = groupRows([row(0, { user_text: '頼み' }), row(1), row(2, { session: 's2' })])
  const groups = days[0]!.groups
  assert.deepEqual(groups.map((g) => [g.speaker, g.session]), [['me', 's1'], ['claude', 's1'], ['claude', 's2']])
})

test('日付が変わったら日ごとの束を分け、グループも跨がない', () => {
  const days = groupRows([row(0), row(24 * 60)])
  assert.equal(days.length, 2)
  assert.notEqual(days[0]!.day, days[1]!.day)
  assert.equal(days[0]!.groups.length, 1)
  assert.equal(days[1]!.groups.length, 1)
})

test('待ちの行は待ちの発言になり、後に同じセッションの行が来ていれば resolved', () => {
  const wait = row(1, { event: 'PermissionRequest', text: '許可待ち: Bash: ls', user_text: '' })
  const open = toUtterances([row(0), wait])
  assert.equal(open.length, 2)
  assert.deepEqual([open[1]!.waiting, open[1]!.resolved, open[1]!.text, open[1]!.speaker], [true, false, '許可待ち: Bash: ls', 'claude'])

  const closed = toUtterances([row(0), wait, row(2)])
  assert.equal(closed[1]!.resolved, true)

  // 別セッションの行では解消しない
  const other = toUtterances([row(0), wait, row(2, { session: 's2' })])
  assert.equal(other[1]!.resolved, false)
})

test('入力の行（UserPromptSubmit + user_text）は自分の発言になり、続くターン完了の同じ入力は重ねない', () => {
  const prompt = row(0, { event: 'UserPromptSubmit', text: '', user_text: '頼み' })
  // 入力 → 返答。自分のバブルは入力の行の分だけ
  const us = toUtterances([prompt, row(1, { user_text: '頼み' })])
  assert.deepEqual(us.map((u) => [u.speaker, u.text]), [['me', '頼み'], ['claude', '返答']])
  assert.equal(us[0]!.row, prompt, '自分の発言は入力の行から')

  // 途中で待ちを挟んでも同じ
  const waited = toUtterances([prompt, row(1, { event: 'PermissionRequest', text: '許可待ち: Bash: ls', user_text: '' }), row(2, { user_text: '頼み' })])
  assert.deepEqual(waited.map((u) => u.speaker), ['me', 'claude', 'claude'])
  assert.equal(waited[1]!.resolved, true)

  // ターン完了の入力が違えば（端末で別の指示を打った）それは出す
  const differ = toUtterances([prompt, row(1, { user_text: '別の指示' })])
  assert.deepEqual(differ.map((u) => [u.speaker, u.text]), [['me', '頼み'], ['me', '別の指示'], ['claude', '返答']])

  // 一度重ねなかったら忘れる。次のターンの同じ入力は出す（入力の行が無かった = フック未設定）
  const again = toUtterances([prompt, row(1, { user_text: '頼み' }), row(2, { user_text: '頼み' })])
  assert.deepEqual(again.map((u) => u.speaker), ['me', 'claude', 'me', 'claude'])

  // 別セッションの入力の行は関係ない
  const other = toUtterances([row(0, { event: 'UserPromptSubmit', text: '', user_text: '頼み', session: 's2' }), row(1, { user_text: '頼み' })])
  assert.deepEqual(other.map((u) => [u.speaker, u.row.session]), [['me', 's2'], ['me', 's1'], ['claude', 's1']])
})

test('合図だけの再開の行（user_text 無し）はバブルにしないが、待ちの解消にはなる', () => {
  const us = toUtterances([row(0, { event: 'PermissionRequest', text: '許可待ち: Bash: ls', user_text: '' }), row(1, { event: 'UserPromptSubmit', text: '', user_text: '' })])
  assert.equal(us.length, 1)
  assert.equal(us[0]!.resolved, true)
  const days = groupRows([row(0), row(1, { event: 'UserPromptSubmit', text: '', user_text: '' })])
  assert.equal(days[0]!.groups[0]!.items.length, 1)
})

test('知らない event の行はバブルにしない（#235）', () => {
  // 集計が数えていないものを出すと、見出しの「N ターン」とバブルの数が合わなくなる
  const out = toUtterances([row(0), row(1, { event: 'SubagentStop', text: '' }), row(2, { event: 'session-configured', text: '中身があっても出さない' })])
  assert.deepEqual(out.map((u) => u.text), ['返答'])
})

test('promptArrived: 送った返信と同じ入力の行が、送信時刻より後（1分の許容）に同じエンティティにあるか', () => {
  const since = at(10)
  const prompt = row(10, { event: 'UserPromptSubmit', text: '', user_text: ' 続きを ' })
  assert.equal(promptArrived([row(0), prompt], 's1@sai', '続きを', since), true)
  assert.equal(promptArrived([row(0), row(10, { event: 'UserPromptSubmit', text: '', user_text: '続きを', session: 's2' })], 's1@sai', '続きを', since), false, '別エンティティ')
  // 入力の行を書かないエージェント（Codex / OpenCode）は `user_text` がターン完了の行に載るので、そちらでも届いたとみなす（#375）
  assert.equal(promptArrived([row(0), row(10, { user_text: '続きを' })], 's1@sai', '続きを', since), true, 'ターン完了の行に載っていても届いた扱い')
  assert.equal(
    promptArrived([row(0), row(10, { event: 'agent-turn-complete', user_text: '続きを' })], 's1@sai', '続きを', since),
    true,
    'Codex のターン完了の行',
  )
  assert.equal(
    promptArrived([row(0), row(10, { event: 'session.idle', user_text: '続きを' })], 's1@sai', '続きを', since),
    true,
    'OpenCode のターン完了の行',
  )
  assert.equal(
    promptArrived([row(0), row(10, { event: 'PreToolUse', text: '許可待ち: Bash', user_text: '続きを' })], 's1@sai', '続きを', since),
    false,
    '待ちの行では判定しない',
  )
  assert.equal(promptArrived([row(0), prompt], 's1@sai', '違う文', since), false)
  assert.equal(promptArrived([row(0), row(5, { event: 'UserPromptSubmit', text: '', user_text: '続きを' })], 's1@sai', '続きを', since), false, '送信より前（許容を超える）')
  assert.equal(promptArrived([row(0), row(9.5, { event: 'UserPromptSubmit', text: '', user_text: '続きを' })], 's1@sai', '続きを', since), true, '30秒前は許容')
})

test('speakerLabel: 表示名・アイコン画像があればそれ、無ければエージェントの固定値。自分は固定', () => {
  assert.deepEqual(speakerLabel('claude', undefined), { name: 'Claude Code', mark: 'C' })
  assert.deepEqual(speakerLabel('codex', {}), { name: 'Codex CLI', mark: 'X' })
  assert.deepEqual(speakerLabel('unknown', undefined), { name: 'unknown', mark: '?' })
  assert.deepEqual(speakerLabel('claude', { meta: { name: '背中メニュー' }, icon: '/i/1' }), { name: '背中メニュー', mark: 'C', icon: '/i/1' })
  assert.deepEqual(speakerLabel('claude', { meta: { name: '背中メニュー' } }), { name: '背中メニュー', mark: 'C' }, '名前だけなら icon キーは無い（頭文字のまま）')
  assert.deepEqual(speakerLabel('claude', { icon: '/i/1' }), { name: 'Claude Code', mark: 'C', icon: '/i/1' })
  assert.deepEqual(speakerLabel('me', { meta: { name: '背中メニュー' }, icon: '/i/1' }), { name: 'あなた', mark: '私' }, '自分側はセッションの表示名・画像に引きずられない')
})

test('groupSpeaker: ふつうのバブルはそのセッションの名前とアイコン。送ったメッセージへの返答は相手の名前とアイコン（#666）', () => {
  const mine = { meta: { name: '送り元' }, icon: '/i/mine' }
  assert.deepEqual(groupSpeaker('claude', mine, undefined), { name: '送り元', mark: 'C', icon: '/i/mine' }, '返答でなければ speakerLabel のまま')
  assert.deepEqual(groupSpeaker('me', mine, { name: 'J', icon: '/i/me' }), { name: 'J', mark: '私', icon: '/i/me' })
  // セッション画面は相手を一覧に持っていない（session が undefined）。印に載った名前とアイコンを出す
  assert.deepEqual(groupSpeaker('claude', undefined, undefined, { to_name: 'くらら', to_icon: '/i/kurara' }), { name: 'くらら', mark: 'C', icon: '/i/kurara' })
  assert.deepEqual(groupSpeaker('codex', undefined, undefined, { to_name: 'くらら' }), { name: 'くらら', mark: 'X' }, '相手がアイコンを付けていなければ頭文字')
  assert.deepEqual(groupSpeaker('claude', { icon: '/i/list' }, undefined, { to_name: 'くらら' }), { name: 'くらら', mark: 'C', icon: '/i/list' }, '印に無くても、一覧から引けたものがあれば出す')
})

test('speakerLabel: 自分は profile があればその名前とアイコン、無ければ「あなた」「私」', () => {
  assert.deepEqual(speakerLabel('me', undefined), { name: 'あなた', mark: '私' })
  assert.deepEqual(speakerLabel('me', undefined, {}), { name: 'あなた', mark: '私' })
  assert.deepEqual(speakerLabel('me', undefined, { name: 'Jesse', icon: '/api/profile/icon?v=1' }), { name: 'Jesse', mark: '私', icon: '/api/profile/icon?v=1' })
  // エージェント側は profile を見ない
  assert.equal(speakerLabel('claude', undefined, { name: 'Jesse' }).name, 'Claude Code')
})

// ---- #385: セッションが終わった行は、発言ではなく区切り線
test('SessionEnd は ended の発言 1 つになり、本文は「なぜ終わったか」', () => {
  const [u] = toUtterances([row(0, { event: 'SessionEnd', text: 'セッション終了: 会話をリセット（/clear）' })])
  assert.equal(u?.ended, true)
  assert.equal(u?.text, 'セッション終了: 会話をリセット（/clear）')
  assert.equal(u?.waiting, undefined, '待ちバブルではない')
})

test('SessionEnd は自分の塊を作り、前後の発言と混ざらない', () => {
  const groups = groupRows([
    row(0, { text: '前の返答' }),
    row(1, { event: 'SessionEnd', text: 'セッション終了: 会話をリセット（/clear）' }),
    row(2, { text: '後の返答' }),
  ])
  const [day] = groups
  assert.equal(day?.groups.length, 3, '同じ発言者・10 分以内でも、区切りを挟んだら別の塊')
  assert.equal(day?.groups[0]?.divider, undefined)
  assert.equal(day?.groups[1]?.divider, true)
  assert.equal(day?.groups[1]?.items.length, 1)
  assert.equal(day?.groups[2]?.divider, undefined)
  assert.equal(day?.groups[2]?.items[0]?.text, '後の返答')
})

test('SessionEnd の行に user_text が載っていても、自分の発言は作らない', () => {
  const out = toUtterances([row(0, { event: 'SessionEnd', text: 'セッション終了: 終了（/exit）', user_text: '前の指示' })])
  assert.equal(out.length, 1)
  assert.equal(out[0]?.ended, true)
})

test('終わって放置されているだけの行（入力待ち）はバブルにしない（#438）', () => {
  // 「ターンが終わった」のは直前の返答のバブルで分かるので、間に「待っています」を挟まない
  const us = toUtterances([row(0, { text: 'できた' }), row(1, { event: 'Notification', text: '入力待ち' })])
  assert.deepEqual(us.map((u) => u.text), ['できた'])

  // 許可待ちは今までどおり待ちバブル
  const waiting = toUtterances([row(0, { text: 'できた' }), row(1, { event: 'Notification', text: '許可待ち: Bash: ls' })])
  assert.deepEqual(waiting.map((u) => [u.text, u.waiting ?? false]), [['できた', false], ['許可待ち: Bash: ls', true]])
})

test('送ったメッセージへの返答（#588）は相手のバブル 1 つだけで、相手に届いた文は自分のバブルにしない。相手のセッションの塊になる', () => {
  const reply = row(5, { session: 's2', user_text: '【SAI】#o/r の「x」からのメッセージです（id: a1）。…', text: '着手しました', agent_reply: { message_id: 'a1', to_name: '明.', sent_at: at(1) } })
  const us = toUtterances([row(0, { user_text: '頼んで' }), reply])
  assert.deepEqual(us.map((x) => [x.speaker, x.text, x.reply?.to_name]), [
    ['me', '頼んで', undefined],
    ['claude', '返答', undefined],
    ['claude', '着手しました', '明.'],
  ])
  const groups = groupRows([row(0), reply])[0]!.groups
  assert.deepEqual(groups.map((g) => g.session), ['s1', 's2'], '同じエージェントでも別のセッションなので塊を分ける')
})

test('toUtterances: SAI が頭に足した返答の塊（#594）は自分のバブルから外し、足した数を添える', () => {
  const user_text = withHandedReplies('人から', [{ message_id: 'ab', to_name: 'かなで', status: 'done', text: 'PR #9' }])
  const [mine] = toUtterances([row(0, { user_text })])
  assert.equal(mine!.text, '人から')
  assert.equal(mine!.handedReplies, 1)
  const [plain] = toUtterances([row(0, { user_text: '人から' })])
  assert.equal(plain!.handedReplies, undefined)
})

test('toUtterances: ループの周の入力（#634）は「ループ N 周目」にして印を付ける。届いたかの判定も同じ形で比べる', () => {
  const user_text = loopPrompt({ goal: 'PR を片付ける', until: '0 件', max_rounds: 10, deadline: at(60), interval_s: 600, round: 3, note: '前の周' }, Date.parse(at(0)))
  const [mine] = toUtterances([row(0, { user_text })])
  assert.deepEqual([mine!.text, mine!.loop], ['ループ 3 周目', true])
  const [plain] = toUtterances([row(0, { user_text: '人から' })])
  assert.equal(plain!.loop, undefined)
  // 処理中の本文はサーバが「ループ 3 周目」にして返す。記録の入力（全文）と突き合う
  const arrived = row(0, { user_text, event: 'UserPromptSubmit', text: '' })
  assert.equal(promptArrived([arrived], entityId(arrived.session, arrived.repo, arrived.ts), 'ループ 3 周目', arrived.ts), true)
  assert.equal(promptArrived([arrived], entityId(arrived.session, arrived.repo, arrived.ts), 'ループ 4 周目', arrived.ts), false)
})

test('入力が自動の要約の文になっているターン完了の行では、自分のバブルを増やさない（#626）', () => {
  const summary = 'This session is being continued from a previous conversation that ran out of context. …'
  const out = toUtterances([row(0, { event: 'UserPromptSubmit', user_text: '頼み', text: '' }), row(5, { user_text: summary })])
  assert.deepEqual(out.map((u) => [u.speaker, u.text]), [['me', '頼み'], ['claude', '返答']])
  // 入力した瞬間の行が窓の外でも、要約を自分の発言にはしない
  assert.deepEqual(toUtterances([row(5, { user_text: summary })]).map((u) => u.speaker), ['claude'])
})
