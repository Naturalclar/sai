// feed/opencode/sai.js（OpenCode のプラグイン）のテスト。プラグインは素の JS で opencode 本体の中で動くが、
// 中身は「イベントを覚えて record.py に payload を渡す」だけなので、偽のイベントを流して payload を見れば足りる。
// `pnpm test` の対象（server/）に置き、record.py の代わりに受け取った payload を書き出すだけの小さい Python を置く。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REAL_PERMISSION, REAL_PERMISSION_TEXT } from '../shared/opencodePermissions.test.ts'

const PLUGIN = pathToFileURL(resolve(import.meta.dirname, '..', 'feed', 'opencode', 'sai.js')).href

interface Hooks {
  event: (input: { event: { type: string; properties: Record<string, unknown> } }) => Promise<void>
}

let home: string
let out: string
const saved = { SAI_HOME: process.env.SAI_HOME, AGENT_FEED_SKIP: process.env.AGENT_FEED_SKIP }

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'sai-oc-plugin-'))
  out = join(home, 'payloads.jsonl')
  await mkdir(join(home, 'feed'), { recursive: true })
  // record.py の代わり。stdin の payload をそのまま 1 行ずつ書き出す
  await writeFile(
    join(home, 'feed', 'record.py'),
    `import sys, os\nwith open(${JSON.stringify(out)}, "a", encoding="utf-8") as f:\n    f.write(sys.stdin.read() + "\\n")\n`,
  )
  process.env.SAI_HOME = home
  delete process.env.AGENT_FEED_SKIP
})

after(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(home, { recursive: true, force: true })
})

async function plugin(): Promise<Hooks> {
  const mod = (await import(PLUGIN)) as { SaiPlugin: (ctx: { directory: string }) => Promise<Hooks> }
  return mod.SaiPlugin({ directory: '/w' })
}

async function payloads(): Promise<Record<string, unknown>[]> {
  const text = await readFile(out, 'utf-8').catch(() => '')
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

const ev = (type: string, properties: Record<string, unknown>) => ({ event: { type, properties } })

/**
 * 人の入力 1 つぶん（役割 → 本文）。session.idle を流す前の「何か増えた」状態にする。
 * 役割（message.updated）を先に送るのは実物と同じ順。送らないと、プラグインは役割の分からない本文を
 * アシスタントの発話として扱う（後から来る分で埋まる前提のため）
 */
async function userSays(hooks: Hooks, session: string, text: string, turn = 1) {
  const id = `u${turn}-${session}`
  await hooks.event(ev('message.updated', { info: { id, sessionID: session, role: 'user' } }))
  await hooks.event(ev('message.part.updated', { part: { type: 'text', sessionID: session, messageID: id, text } }))
  await hooks.event(ev('message.updated', { info: { id: `a-${session}`, sessionID: session, role: 'assistant', providerID: 'ollama', modelID: 'qwen3:8b' } }))
}

test('本文の無いターン: 許可が拒否されたツールから「何が起きたか」を出す（#273。opencode run の自動 reject）', async () => {
  const hooks = await plugin()
  await userSays(hooks, 'S1', 'calc.py を読んで')
  // 実物（opencode 1.18.30 の run）と同じ形の失敗したツールのパーツ
  await hooks.event(
    ev('message.part.updated', {
      part: {
        type: 'tool',
        tool: 'read',
        sessionID: 'S1',
        messageID: 'a-S1',
        state: { status: 'error', input: { filePath: '/x/calc.py' }, error: 'The user rejected permission to use this specific tool call.' },
      },
    }),
  )
  await hooks.event(ev('session.idle', { sessionID: 'S1' }))
  const idle = (await payloads()).find((p) => p.session_id === 'S1' && p.type === 'session.idle')
  assert.ok(idle, 'session.idle の payload が渡る')
  assert.equal(idle.user_text, 'calc.py を読んで')
  assert.match(String(idle.text), /^（本文なし）read の許可が拒否されて終わりました/)
  assert.match(String(idle.text), /rejected permission/, '元のメッセージも添える')
  assert.equal(idle.model, 'ollama/qwen3:8b')
})

test('本文があれば本文を出す（失敗したツールがあっても上書きしない）', async () => {
  const hooks = await plugin()
  await userSays(hooks, 'S2', 'バグを指摘して')
  await hooks.event(ev('message.part.updated', { part: { type: 'tool', tool: 'glob', sessionID: 'S2', messageID: 'a-S2', state: { status: 'error', error: 'boom' } } }))
  await hooks.event(ev('message.part.updated', { part: { type: 'text', sessionID: 'S2', messageID: 'a-S2', text: 'add が引き算になっています。' } }))
  await hooks.event(ev('session.idle', { sessionID: 'S2' }))
  const idle = (await payloads()).find((p) => p.session_id === 'S2' && p.type === 'session.idle')
  assert.equal(idle?.text, 'add が引き算になっています。')
})

test('拒否以外の失敗はメッセージをそのまま添える。次のターンに持ち越さない', async () => {
  const hooks = await plugin()
  await userSays(hooks, 'S3', '1回目')
  await hooks.event(ev('message.part.updated', { part: { type: 'tool', tool: 'bash', sessionID: 'S3', messageID: 'a-S3', state: { status: 'error', error: 'command not found' } } }))
  await hooks.event(ev('session.idle', { sessionID: 'S3' }))
  // 2 回目のターンは人の入力だけで、本文も失敗も無い
  await userSays(hooks, 'S3', '2回目', 2)
  await hooks.event(ev('session.idle', { sessionID: 'S3' }))
  const idles = (await payloads()).filter((p) => p.session_id === 'S3' && p.type === 'session.idle')
  assert.equal(idles.length, 2)
  assert.equal(idles[0]!.text, '（本文なし）bash が失敗して終わりました: command not found')
  assert.equal(idles[1]!.user_text, '2回目')
  assert.equal(idles[1]!.text, '', '前のターンの失敗を持ち越さない（本当に空なら空のまま）')
})

test('何も増えていない session.idle は流さない（1 ターンに複数回鳴る）', async () => {
  const hooks = await plugin()
  await userSays(hooks, 'S4', 'こんにちは')
  await hooks.event(ev('session.idle', { sessionID: 'S4' }))
  await hooks.event(ev('session.idle', { sessionID: 'S4' }))
  const idles = (await payloads()).filter((p) => p.session_id === 'S4' && p.type === 'session.idle')
  assert.equal(idles.length, 1)
})

test('送っている最中に次の idle が届いても、行は 1 本（止めたときは同じ秒に 2 回鳴る。#392）', async () => {
  const hooks = await plugin()
  await userSays(hooks, 'AB1', '数えて')
  // 1 本目の送信（record.py の終了待ち）が終わる前に 2 本目が届く。前は `dirty` を送ったあとで下ろしていたので、
  // 2 本目も同じ行（自分の入力つき）を書き、画面に自分のバブルと「(本文なし)」が 2 つずつ並んだ
  await Promise.all([hooks.event(ev('session.idle', { sessionID: 'AB1' })), hooks.event(ev('session.idle', { sessionID: 'AB1' }))])
  const idles = (await payloads()).filter((p) => p.session_id === 'AB1' && p.type === 'session.idle')
  assert.equal(idles.length, 1)
  assert.equal(idles[0]!.user_text, '数えて')
})

test('本文が出る前に止めたターンは「途中で止めました」。止めた印は次のターンに持ち越さない（#392）', async () => {
  const hooks = await plugin()
  await userSays(hooks, 'AB2', '1 から 300 まで数えて')
  // 実機（1.18.30）で止めたときの順: session.error → session.idle → …（MessageAbortedError の更新）… → session.idle
  await hooks.event(ev('session.error', { sessionID: 'AB2', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } }))
  await Promise.all([
    hooks.event(ev('session.idle', { sessionID: 'AB2' })),
    hooks
      .event(ev('message.updated', { info: { id: 'a-AB2', sessionID: 'AB2', role: 'assistant', error: { name: 'MessageAbortedError' } } }))
      .then(() => hooks.event(ev('session.idle', { sessionID: 'AB2' }))),
  ])
  // 次のターンは普通に本文なしで終わる
  await userSays(hooks, 'AB2', '次', 2)
  await hooks.event(ev('session.idle', { sessionID: 'AB2' }))
  const idles = (await payloads()).filter((p) => p.session_id === 'AB2' && p.type === 'session.idle')
  assert.deepEqual(
    idles.map((p) => [p.user_text, p.text]),
    [
      ['1 から 300 まで数えて', '（本文なし）途中で止めました'],
      ['次', ''],
    ],
  )
})

test('途中まで本文が出ていれば、止めても本文のまま（#392）', async () => {
  const hooks = await plugin()
  await userSays(hooks, 'AB3', '数えて')
  await hooks.event(ev('message.part.updated', { part: { type: 'text', sessionID: 'AB3', messageID: 'a-AB3', text: '1\n2\n3' } }))
  await hooks.event(ev('session.error', { sessionID: 'AB3', error: { name: 'MessageAbortedError' } }))
  await hooks.event(ev('session.idle', { sessionID: 'AB3' }))
  const idle = (await payloads()).find((p) => p.session_id === 'AB3' && p.type === 'session.idle')
  assert.equal(idle?.text, '1\n2\n3')
})

test('止めた以外の session.error では「止めました」にしない（#392）', async () => {
  const hooks = await plugin()
  await userSays(hooks, 'AB4', 'やって')
  await hooks.event(ev('session.error', { sessionID: 'AB4', error: { name: 'ProviderAuthError' } }))
  await hooks.event(ev('session.idle', { sessionID: 'AB4' }))
  const idle = (await payloads()).find((p) => p.session_id === 'AB4' && p.type === 'session.idle')
  assert.equal(idle?.text, '')
})

test('許可待ちの行に、何を聞かれているかまで出す（#421。実物の payload と shared 側の期待文字列が同じ）', async () => {
  const hooks = await plugin()
  // 実機（1.18.30）の permission.asked の properties そのまま（shared/opencodePermissions.test.ts と同じもの）
  await hooks.event(ev('permission.asked', { ...REAL_PERMISSION, sessionID: 'S5' }))
  const asked = (await payloads()).find((p) => p.session_id === 'S5' && p.type === 'permission.asked')
  assert.ok(asked, 'permission.asked の payload が渡る')
  assert.equal(asked.text, REAL_PERMISSION_TEXT)
})

test('許可待ち: キーの大文字小文字は見ない（実物は filepath、以前の想定は filePath。#421）', async () => {
  const hooks = await plugin()
  await hooks.event(ev('permission.asked', { id: 'per_4', sessionID: 'S8', permission: 'edit', patterns: [], metadata: { filePath: '/w/calc.py' } }))
  assert.equal((await payloads()).find((p) => p.session_id === 'S8')?.text, '許可待ち: edit: /w/calc.py')
})

test('許可待ち: metadata から拾えなければ patterns、それも無ければ種類だけ（#421）', async () => {
  const hooks = await plugin()
  await hooks.event(ev('permission.asked', { id: 'per_2', sessionID: 'S6', permission: 'external_directory', patterns: ['/etc/*'], metadata: {} }))
  await hooks.event(ev('permission.asked', { id: 'per_3', sessionID: 'S7', permission: 'bash', patterns: [], metadata: {} }))
  const rows = await payloads()
  assert.equal(rows.find((p) => p.session_id === 'S6')?.text, '許可待ち: external_directory: /etc/*')
  assert.equal(rows.find((p) => p.session_id === 'S7')?.text, '許可待ち: bash')
})
