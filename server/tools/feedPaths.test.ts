// 週ごとの経路の数（#845）。**本物の置き場は触らない**（一時ディレクトリに記録を置く）。
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { FeedRow } from '../../shared/types.ts'
import { TERMINAL_DIALOG_LOG, TERMINAL_TYPED_LOG } from '../reply/terminal.ts'
import { run } from './feed.ts'
import { DELIVERY_LOG_HEADS, deliveryOfLogLine, pathsRange, readDeliveries, weekOf, weeklyPaths } from './feedPaths.ts'
import type { DeliveryEntry } from './feedPaths.ts'

const ID = 'aaaa1111@dev-a'
const line = (rest: string) => `--- 2026-10-27T01:00:00.000Z ${ID} ${rest}`
const turn = (ts: string, agent: string, pane = ''): FeedRow => ({ ts, agent, repo: 'dev-a', branch: 'main', session: 's', event: 'Stop', text: '終わり', pane, project: 'acme/app' }) as FeedRow
const at = (ts: string, delivery: DeliveryEntry['delivery']): DeliveryEntry => ({ ts, delivery })

test('deliveryOfLogLine: 書く側の決まった文だけを届け方に読む', () => {
  const cases: [string, string | null][] = [
    [TERMINAL_TYPED_LOG, 'terminal'],
    [TERMINAL_DIALOG_LOG, 'dialog'],
    ['claude ["-p","--resume","x"] (cwd /work)', 'process'],
    ['codex ["exec","resume","x"] (cwd /work)', 'process'],
    ['開いている Codex へ queue ["queue"] (cwd /work)', 'queue'],
    ['Codex app-server で再開（thread/resume → turn/start） (cwd /work)', 'app_server'],
    ['opencode serve へ送る（prompt_async） (cwd /work)', 'app_server'],
    ['OpenCode の新しいセッション（POST /session → prompt_async） (cwd /work)', 'app_server'],
    ['メッセージを端末に打ち込めない（入力中）ので、別プロセスを起こさずに預かった（1 件目）', 'parked'],
    // 似ているが届け方ではない文。同じ 1 通の取り直しも数えない
    ['メッセージを端末に打ち込めない（入力中）ので、別プロセスを起こさずに待つ', null],
    ['メッセージを端末に打ち込めない（入力中）ので、別プロセスを起こさずに預かりを止めた', null],
    ['端末に打ち込んだ返信でターンが始まっていない: 理由', null],
    ['端末に打ち込んだ返信のターンがエラーで終わった: 理由', null],
    ['端末の打ちかけを消して打ち込んだ: "x"', null],
    ['処理中なので預かった（1 件目）', null],
  ]
  for (const [rest, want] of cases) assert.equal(deliveryOfLogLine(line(rest))?.delivery ?? null, want, rest)
  assert.equal(deliveryOfLogLine(`--- 2026-10-27T01:00:00.000Z バックグラウンドで新しいセッション（claude --bg） (cwd /work)`), null)
  assert.equal(deliveryOfLogLine(`子の出力 ${line(TERMINAL_TYPED_LOG)}`), null, '行の頭でなければ数えない')
  assert.equal(deliveryOfLogLine(`--- 昨日 ${ID} ${TERMINAL_TYPED_LOG}`), null, '時刻が読めなければ数えない')
})

test('deliveryOfLogLine: 読む文の頭は、書く側の server/app.ts に今もある', async () => {
  const app = await readFile(new URL('../app.ts', import.meta.url), 'utf-8')
  for (const [prefix] of DELIVERY_LOG_HEADS) assert.ok(app.includes(prefix.trimEnd()), prefix)
  assert.ok(app.includes('${TERMINAL_TYPED_LOG}\\n'))
  assert.ok(app.includes('${TERMINAL_DIALOG_LOG}\\n'))
  assert.ok(app.includes('ので、別プロセスを起こさずに預かった（'))
})

test('weekOf: 月曜始まり。年をまたいでも月曜の日付になる', () => {
  assert.equal(weekOf('2026-11-02'), '2026-11-02', '月曜')
  assert.equal(weekOf('2026-11-01'), '2026-10-26', '日曜は前の週')
  assert.equal(weekOf('2027-01-01'), '2026-12-28')
})

test('pathsRange: 今週を含む 4 週の月曜から今日まで（Asia/Tokyo）', () => {
  assert.deepEqual(pathsRange(new Date('2026-11-01T15:30:00Z')), { from: '2026-10-12', to: '2026-11-02' }, 'UTC では日曜でも東京は月曜')
})

test('weeklyPaths: ペインの中 / 外をエージェントごとに週で数え、ターン完了以外と範囲の外は数えない', () => {
  const range = { from: '2026-10-26', to: '2026-11-02' }
  const weeks = weeklyPaths({
    rows: [
      turn('2026-10-26T00:30:00+09:00', 'claude', '%1'),
      turn('2026-10-27T10:00:00+09:00', 'claude'),
      turn('2026-11-01T23:59:00+09:00', 'codex'),
      turn('2026-11-02T00:00:00+09:00', 'codex', '%2'),
      turn('2026-10-25T23:59:00+09:00', 'claude', '%1'),
      { ...turn('2026-10-27T11:00:00+09:00', 'claude', '%1'), event: 'UserPromptSubmit', text: '' } as FeedRow,
    ],
    deliveries: [],
    range,
  })
  assert.deepEqual(weeks.map((w) => [w.week, w.partial, w.in_pane, w.outside]), [['2026-10-26', false, 1, 2], ['2026-11-02', true, 1, 0]])
  assert.deepEqual(weeks[0]!.turns, [{ agent: 'claude', in_pane: 1, outside: 1 }, { agent: 'codex', in_pane: 0, outside: 1 }])
})

test('weeklyPaths: 端末の数は書き始めた週の次から。その前は 0 でなく null', () => {
  const range = { from: '2026-10-19', to: '2026-11-08' }
  const weeks = weeklyPaths({
    rows: [],
    deliveries: [
      at('2026-10-20T01:00:00.000Z', 'process'),
      at('2026-10-20T01:00:00.000Z', 'queue'),
      at('2026-10-27T01:00:00.000Z', 'terminal'),
      at('2026-10-27T02:00:00.000Z', 'app_server'),
      at('2026-10-27T03:00:00.000Z', 'parked'),
      at('2026-11-03T01:00:00.000Z', 'terminal'),
      at('2026-11-04T01:00:00.000Z', 'terminal'),
      at('2026-12-01T01:00:00.000Z', 'terminal'),
      at('2026-10-20T01:00:00.000Z', 'dialog'),
      at('2026-10-27T01:00:00.000Z', 'dialog'),
    ],
    range,
  })
  assert.deepEqual(weeks.map((w) => w.deliveries.terminal), [null, null, 2])
  assert.deepEqual(weeks[0]!.deliveries, { terminal: null, process: 1, app_server: 0, queue: 1, parked: 0 })
  assert.deepEqual(weeks[1]!.deliveries, { terminal: null, process: 0, app_server: 1, queue: 0, parked: 1 })
  assert.deepEqual(weeks.map((w) => w.dialogs), [null, 1, 0])
})

test('weeklyPaths: 端末の行が 1 本も無ければ全部の週が null。何も無い週も出す', () => {
  const weeks = weeklyPaths({ rows: [], deliveries: [], range: { from: '2026-10-26', to: '2026-11-08' } })
  assert.deepEqual(weeks.map((w) => [w.week, w.deliveries.terminal, w.dialogs]), [['2026-10-26', null, null], ['2026-11-02', null, null]])
})

test('weeklyPaths: 範囲が週の途中から始まる週も partial', () => {
  const [w] = weeklyPaths({ rows: [], deliveries: [], range: { from: '2026-10-28', to: '2026-11-01' } })
  assert.deepEqual([w!.week, w!.partial], ['2026-10-26', true])
})

test('feed paths: 表と JSON を数だけで出す。reply.log が無くても動く', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feed-paths-'))
  try {
    const rowText = (r: Record<string, unknown>) => `${JSON.stringify({ repo: 'リポジトリの名前', branch: 'main', session: 's', project: 'acme/secret', cwd: '/work/秘密のパス', user_text: '本文の入力', ...r })}\n`
    await writeFile(join(dir, '2026-10-27.jsonl'), rowText({ ts: '2026-10-27T10:00:00+09:00', agent: 'claude', event: 'Stop', text: '本文の返答', pane: '%1' }))
    const out: string[] = []
    const io = { dir, now: new Date('2026-10-28T03:00:00Z'), out: (l: string) => out.push(l), err: (l: string) => out.push(l) }
    assert.equal(await run(['paths'], io), 0, 'reply.log が無い')
    await writeFile(join(dir, 'reply.log'), `${line('claude ["-p"] (cwd /work/秘密のパス)')}\n{"type":"子の出力"}\n`)
    out.length = 0
    assert.equal(await run(['paths'], io), 0)
    const text = out.join('\n')
    assert.match(text, /2026-10-26\*\s+claude\s+1\s+0\s+100\.0%/)
    assert.match(text, /2026-10-26\*\s+\?\s+1\s+0\s+0\s+0\s+\?/)
    for (const secret of ['秘密のパス', 'リポジトリの名前', 'acme/secret', '本文の']) assert.ok(!text.includes(secret), secret)
    out.length = 0
    assert.equal(await run(['paths', '--json'], io), 0)
    const json = JSON.parse(out.join('')) as { weeks: { week: string; deliveries: { terminal: number | null } }[] }
    assert.equal(json.weeks.length, 4)
    assert.equal(json.weeks.at(-1)!.deliveries.terminal, null)
    for (const secret of ['秘密のパス', 'リポジトリの名前', 'acme/secret', '本文の']) assert.ok(!out.join('').includes(secret), secret)
    assert.equal(await run(['paths', '--by', 'day'], io), 2, '効かないオプションはエラー')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readDeliveries: 無いファイルは空', async () => {
  assert.deepEqual(await readDeliveries(join(tmpdir(), 'feed-paths-存在しない')), [])
})
