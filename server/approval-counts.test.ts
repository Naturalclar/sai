// 許可した回数を数えて「常に許可」を勧める（#445）。本物の createApp に一時の feed dir を渡して、
// 人が許可した回数が cwd とルールごとに数えられ、決めた回数目の許可に count / suggest が付くこと、
// 記録（approvals.jsonl）にコマンドの全文が入らないこと、立て直しても数が残ることを見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalLogRow, ReplyingMap, SessionPermissionsResponse, SessionsResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { APPROVAL_LOG_FILE, ApprovalLog } from './approvals/approvalLog.ts'
import { APPROVAL_COUNT_DAYS } from '../shared/approvalCounts.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import type { Runner } from './reply/runner.ts'

const runner: Runner = { running: () => false, snapshot: (): ReplyingMap => ({}), start: async () => {} }

let dir: string
let feedDir: string
let cwdA: string
let cwdB: string
const servers: Server[] = []
const saved: Record<string, string | undefined> = {}

async function start(approvals: Approvals, allowedRules?: (cwd: string) => Promise<string[]>): Promise<string> {
  const app = createApp(new FeedStore(feedDir), join(dir, 'dist'), runner, approvals, undefined, undefined, undefined, { tmux: { run: async () => '' }, ps: async () => '', ...(allowedRules ? { allowedRules } : {}) })
  const server = createServer((req, res) => void app(req, res))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}

const pending = async (base: string, id: string) => ((await (await fetch(`${base}/api/sessions`)).json()) as SessionsResponse).approvals[id] ?? []
const answer = (base: string, approvalId: string, body: unknown, origin = base) =>
  fetch(`${base}/api/approvals/${approvalId}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) })
const logRows = async (): Promise<ApprovalLogRow[]> =>
  (await readFile(join(feedDir, APPROVAL_LOG_FILE), 'utf-8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as ApprovalLogRow)
/** 記録は投げっぱなしで足すので、書かれるまで少し待つ */
const settle = () => new Promise((r) => setTimeout(r, 30))

before(async () => {
  for (const key of ['SAI_TERMINAL', 'SAI_CODEX_APP_SERVER', 'SAI_OPENCODE_SERVER']) {
    saved[key] = process.env[key]
    process.env[key] = '0'
  }
  dir = await mkdtemp(join(tmpdir(), 'sai-approval-counts-'))
  feedDir = join(dir, 'feed')
  cwdA = join(dir, 'a')
  cwdB = join(dir, 'b')
  await Promise.all([mkdir(feedDir), mkdir(cwdA), mkdir(cwdB)])
  const now = new Date()
  const lines = [row(now, 'S1', { repo: 'r', cwd: cwdA }), row(now, 'S2', { repo: 'r2', cwd: cwdB })]
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
})

after(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('同じルールを 2 回許可すると、3 回目の許可に count: 3 と suggest: true が付く。cwd が違えば数えない。拒否は数えない', async () => {
  const approvals = new Approvals()
  const base = await start(approvals)
  // zzsai は実在しないコマンド（回したマシンの ~/.claude/settings.json のルールに当たらないように）
  for (const [n, flag] of [[1, '--one'], [2, '--secret-two']] as const) {
    approvals.ask('S1@r', 'Bash', { command: `zzsai ${flag}` }, `t${n}`)
    const [a] = await pending(base, 'S1@r')
    assert.equal(a!.count, n, `${n} 回目`)
    assert.equal(a!.suggest, false, '2 回目まではまだ勧めない')
    assert.equal((await answer(base, a!.approval_id, { behavior: 'allow' })).status, 200)
  }
  // 拒否は数えない
  approvals.ask('S1@r', 'Bash', { command: 'zzsai --denied' }, 't-deny')
  const [denied] = await pending(base, 'S1@r')
  assert.equal(denied!.count, 3)
  assert.equal((await answer(base, denied!.approval_id, { behavior: 'deny' })).status, 200)

  approvals.ask('S1@r', 'Bash', { command: 'zzsai --three' }, 't3')
  approvals.ask('S1@r', 'Edit', { file_path: '/x' }, 't4')
  approvals.ask('S2@r2', 'Bash', { command: 'zzsai --other-cwd' }, 't5')
  const [third, edit] = await pending(base, 'S1@r')
  assert.deepEqual([third!.count, third!.suggest], [3, true], '3 回目から「常に許可」を勧める')
  assert.deepEqual([edit!.count, edit!.suggest], [undefined, undefined], 'ルールが作れないツールは数えない')
  const [other] = await pending(base, 'S2@r2')
  assert.deepEqual([other!.count, other!.suggest], [1, false], 'cwd が違えば数えない')

  // 別オリジンからは答えられず、数も増えない（答えの口は同一オリジンのみ）
  assert.equal((await answer(base, third!.approval_id, { behavior: 'allow' }, 'https://evil.example')).status, 403)
  assert.equal((await pending(base, 'S1@r'))[0]!.count, 3)

  // 記録: 誰が・どのルールを・どう答えたかだけ。コマンドの全文は入らない
  await settle()
  const rows = await logRows()
  assert.deepEqual(rows.map((r) => [r.id, r.cwd, r.tool, r.rule, r.by, r.behavior, r.remember]), [
    ['S1@r', cwdA, 'Bash', 'Bash(zzsai:*)', 'human', 'allow', false],
    ['S1@r', cwdA, 'Bash', 'Bash(zzsai:*)', 'human', 'allow', false],
    ['S1@r', cwdA, 'Bash', 'Bash(zzsai:*)', 'human', 'deny', false],
  ])
  assert.ok(!JSON.stringify(rows).includes('--secret-two'), 'コマンドの全文は書かない')
  assert.ok(rows.every((r) => Number.isFinite(r.waited_s) && r.waited_s >= 0 && !Number.isNaN(Date.parse(r.ts))))

  // 盾のモーダル: よく許可しているが、許可のルールに無いもの
  const perms = (await (await fetch(`${base}/api/sessions/${encodeURIComponent('S1@r')}/permissions`)).json()) as SessionPermissionsResponse
  assert.deepEqual(perms.frequent, [{ rule: 'Bash(zzsai:*)', count: 2 }])
  const none = (await (await fetch(`${base}/api/sessions/${encodeURIComponent('S2@r2')}/permissions`)).json()) as SessionPermissionsResponse
  assert.equal(none.frequent, undefined)

  // 立て直しても数は残る（記録から数え直す）
  const again = new Approvals()
  const base2 = await start(again)
  again.ask('S1@r', 'Bash', { command: 'zzsai --after-restart' }, 't6')
  assert.deepEqual((await pending(base2, 'S1@r')).map((a) => [a.count, a.suggest]), [[3, true]])

  // 「常に許可」で答えても、サーバが組んだルールで答えるだけ（画面からルールは受けない）。記録には remember が付く
  const [last] = await pending(base2, 'S1@r')
  const res = await answer(base2, last!.approval_id, { behavior: 'allow', remember: 'local', updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' }] })
  assert.equal(((await res.json()) as { remembered?: string }).remembered, 'Bash(zzsai:*)')
  await settle()
  assert.equal((await logRows()).at(-1)!.remember, true)
})

test('つないだコマンドは部品ごとにルールを書く（#705）: 何が書かれるかを応答に載せ、回数は組で数え、もう設定にある部品は足さない', async () => {
  const approvals = new Approvals()
  await settle()
  const logged = (await logRows()).length
  // cwdB にだけ、もう zztee のルールがある
  const base = await start(approvals, async (cwd) => (cwd === cwdB ? ['Bash(zztee:*)', 'Bash(zzall:*)'] : []))
  const ask = (id: string, command: string, t: string) => approvals.ask(id, 'Bash', { command }, t)

  // cd にはルールを書かない（効かない）。後ろの部品ごとに書く
  ask('S1@r', 'cd sub && zzrun test --secret | zztee log', 'c1')
  const [first] = await pending(base, 'S1@r')
  assert.deepEqual(first!.always, ['Bash(zzrun:*)', 'Bash(zztee:*)'], '押す前に、書かれるルールが全部見える')
  assert.equal(first!.count, 1)
  const res = await answer(base, first!.approval_id, { behavior: 'allow', remember: 'local' })
  assert.equal(((await res.json()) as { remembered?: string }).remembered, 'Bash(zzrun:*) + Bash(zztee:*)')
  assert.deepEqual((await approvals.wait(first!.approval_id, 10))?.updatedPermissions, [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'zzrun:*' }, { toolName: 'Bash', ruleContent: 'zztee:*' }], behavior: 'allow', destination: 'localSettings' },
  ])

  // 回数は組で数える: 同じ先頭でも、後ろが違えば別（前は先頭の語だけで束ねていた）
  ask('S1@r', 'zzrun build | zztee log', 'c2')
  ask('S1@r', 'zzrun build', 'c3')
  const [same, alone] = await pending(base, 'S1@r')
  assert.deepEqual([same!.always, same!.count], [['Bash(zzrun:*)', 'Bash(zztee:*)'], 2])
  assert.deepEqual([alone!.always, alone!.count], [['Bash(zzrun:*)'], 1])
  for (const a of [same!, alone!]) assert.equal((await answer(base, a.approval_id, { behavior: 'deny' })).status, 200)

  // 通らないと分かった形・ルールを作れない部品があるものには [常に許可] を出さず、押しても 400
  const refused = ['cd sub && touch x', 'cd /tmp && zzrun x', 'for i in 1 2; do zzrun x; done', 'zzrun x > out.txt', 'cd sub']
  refused.forEach((command, i) => ask('S1@r', command, `n${i}`))
  const none = await pending(base, 'S1@r')
  assert.deepEqual(none.map((a) => [a.always, a.count]), refused.map(() => [undefined, undefined]))
  for (const a of none) {
    assert.equal((await answer(base, a.approval_id, { behavior: 'allow', remember: 'local' })).status, 400, String(a.input.command))
    assert.equal((await answer(base, a.approval_id, { behavior: 'deny' })).status, 200)
  }

  // もう設定にある部品は足さない。全部あるなら [常に許可] を出さない
  ask('S2@r2', 'zzrun test | zztee log', 'c4')
  ask('S2@r2', 'zzall a && zztee log', 'c5')
  const [partly, covered] = await pending(base, 'S2@r2')
  assert.deepEqual(partly!.always, ['Bash(zzrun:*)'], '設定にある zztee は足さない')
  assert.equal(covered!.always, undefined, '全部もう設定にある')
  assert.equal((await answer(base, covered!.approval_id, { behavior: 'allow', remember: 'local' })).status, 400)
  assert.equal((await answer(base, covered!.approval_id, { behavior: 'allow' })).status, 200)
  assert.equal((await answer(base, partly!.approval_id, { behavior: 'allow', remember: 'local' })).status, 200)
  assert.deepEqual((await approvals.wait(partly!.approval_id, 10))?.updatedPermissions?.[0]?.rules, [{ toolName: 'Bash', ruleContent: 'zzrun:*' }])

  await settle()
  const rows = (await logRows()).filter((r) => r.rule.includes('zzrun'))
  assert.ok(rows.some((r) => r.rule === 'Bash(zzrun:*) + Bash(zztee:*)' && r.remember), '記録の鍵も組')
  assert.ok(!JSON.stringify(await logRows()).includes('--secret'), 'コマンドの全文は書かない')

  // ルールが空だった行には、なぜ空かの種類が残る（#724）。組めなかった形と、組めたが全部もう設定にあるものを分ける
  // 書き込みは待たずに足されるので、並びでなく中身で比べる。このテストが足した行だけを見る
  let all = (await logRows()).slice(logged)
  for (let i = 0; i < 40 && all.filter((r) => !r.rule).length < 6; i++) {
    await settle()
    all = (await logRows()).slice(logged)
  }
  const reasons = all.filter((r) => !r.rule).map((r) => r.no_rule).sort()
  assert.deepEqual(reasons, ['cd_only', 'cd_outside', 'cd_then_write', 'covered', 'keyword', 'redirect'])
  assert.ok(all.filter((r) => r.rule).every((r) => !('no_rule' in r)), 'ルールがある行には載せない')
  // 種類だけ。コマンドの文字・引数・パスは書かない
  // （行の `cwd` はセッションの行のもので、Linux では一時ディレクトリが /tmp の下になるので外して見る）
  const bare = JSON.stringify(all.filter((r) => !r.rule).map((r) => ({ ...r, cwd: '' })))
  for (const word of ['out.txt', '/tmp', 'touch', 'zzall', 'do zzrun']) assert.ok(!bare.includes(word), word)

  // Bash でないツール（もともとルールが無い）は not_bash
  approvals.ask('S1@r', 'Edit', { file_path: join(cwdA, 'secret-name.ts'), old_string: 'a', new_string: 'b' }, 'e1')
  const [edit] = await pending(base, 'S1@r')
  assert.equal((await answer(base, edit!.approval_id, { behavior: 'allow' })).status, 200)
  await settle()
  const last = (await logRows()).at(-1)!
  assert.deepEqual([last.tool, last.rule, last.no_rule], ['Edit', '', 'not_bash'])
  assert.ok(!JSON.stringify(last).includes('secret-name'))
})

test('ApprovalLog: 数えるのは直近の日数ぶんだけ。Jev の自動・cwd の無い行・壊れた行は数えない', async () => {
  const d = await mkdtemp(join(tmpdir(), 'sai-approval-log-'))
  try {
    const now = Date.parse('2026-10-01T12:00:00Z')
    const at = (days: number) => new Date(now - days * 86_400_000).toISOString()
    const base = { id: 'S@r', cwd: '/w', tool: 'Bash', rule: 'Bash(gh pr:*)', by: 'human', behavior: 'allow', remember: false, waited_s: 1 } as const
    const lines = [
      { ...base, ts: at(1) },
      { ...base, ts: at(APPROVAL_COUNT_DAYS + 1) },
      { ...base, ts: at(2), by: 'jev' },
      { ...base, ts: at(2), cwd: '' },
      { ...base, ts: at(3), rule: 'Bash(pnpm test:*)' },
    ]
    const path = join(d, APPROVAL_LOG_FILE)
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n{こわれた行\n')
    const log = new ApprovalLog(path, () => now)
    assert.equal(log.count('/w', 'Bash(gh pr:*)'), 1)
    assert.equal(log.count('/other', 'Bash(gh pr:*)'), 0)
    log.record({ ...base, ts: at(0) })
    assert.equal(log.count('/w', 'Bash(gh pr:*)'), 2)
    assert.deepEqual(log.frequent('/w', []), [{ rule: 'Bash(gh pr:*)', count: 2 }], '1 回だけのものは出さない')
    assert.deepEqual(log.frequent('/w', ['Bash(gh pr:*)']), [], 'もうルールにあるものは出さない')
    assert.deepEqual(log.frequent('/w', ['Bash(gh:*)']), [], 'より広いルールで覆われているものも出さない（#621 のレビュー）')
  } finally {
    await rm(d, { recursive: true, force: true })
  }
})
