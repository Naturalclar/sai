// #382。`opencode` のバイナリには触らず、**本物の HTTP サーバ**を立てて送り先の形を確かめる
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { OpencodeServer, listeningUrl, promptBody } from './opencodeServer.ts'

test('promptBody: 本文は text のパーツ。モデルは最初の / で割る（モデル名に / が入ることがある）', () => {
  assert.deepEqual(promptBody({ id: 'E', session: 'ses_1', text: 'やって' }), { parts: [{ type: 'text', text: 'やって' }] })
  const withModel = promptBody({ id: 'E', session: 'ses_1', text: 'やって', model: 'ollama/qwen3:8b' })
  assert.deepEqual(withModel.model, { providerID: 'ollama', modelID: 'qwen3:8b' })
  assert.deepEqual(promptBody({ id: 'E', session: 'ses_1', text: 'x', model: 'openrouter/meta/llama-3' }).model, { providerID: 'openrouter', modelID: 'meta/llama-3' })
  // 形の違う指定は付けない（CLI に任せる = セッションのモデルのまま）
  assert.equal(promptBody({ id: 'E', session: 'ses_1', text: 'x', model: 'opus' }).model, undefined)
})

test('promptBody: 添えた画像は file のパーツ（mime は拡張子から、url は file://）', () => {
  const body = promptBody({ id: 'E', session: 'ses_1', text: '見て', attachments: ['/tmp/a/b.png', '/tmp/a/c.bin'] })
  assert.deepEqual(body.parts, [
    { type: 'text', text: '見て' },
    { type: 'file', mime: 'image/png', filename: 'b.png', url: 'file:///tmp/a/b.png' },
    { type: 'file', mime: 'application/octet-stream', filename: 'c.bin', url: 'file:///tmp/a/c.bin' },
  ])
})

test('listeningUrl: 立ち上がりの 1 行から待ち受け先を取る', () => {
  assert.equal(listeningUrl('opencode server listening on http://127.0.0.1:52341\n'), 'http://127.0.0.1:52341')
  assert.equal(listeningUrl('Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\n'), '')
})

test('start: prompt_async に鍵つきで POST し、行が届くまで「処理中」にする', async () => {
  const seen: { url: string; auth: string; body: unknown }[] = []
  let status = 204
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization ?? '', body: raw ? JSON.parse(raw) : null })
      res.writeHead(status, { 'content-type': 'text/plain' })
      res.end(status === 204 ? '' : 'session not found')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  try {
    let now = Date.parse('2026-09-16T10:00:00Z')
    const app = new OpencodeServer(fetch, () => now, async () => ({ url: base, auth: 'Basic dGVzdA==' }))
    await app.start({ id: 'S1@r', session: 'ses_abc', text: 'テストして', model: 'ollama/qwen3:8b' })

    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.url, '/session/ses_abc/prompt_async')
    assert.equal(seen[0]!.auth, 'Basic dGVzdA==', '鍵を付ける（鍵が無いとサーバは 401 を返す）')
    assert.deepEqual(seen[0]!.body, { model: { providerID: 'ollama', modelID: 'qwen3:8b' }, parts: [{ type: 'text', text: 'テストして' }] })

    assert.equal(app.running('S1@r'), true)
    assert.equal(app.replying()['S1@r']?.text, 'テストして')
    assert.equal(app.replying()['S1@r']?.via, undefined, '端末ではないので via は付けない（別プロセスと同じ扱い）')

    // 送る前のターン完了では終わらない（前のターンの行を拾わない）
    assert.deepEqual(app.settle(() => '2026-09-16T09:00:00Z'), [])
    assert.equal(app.running('S1@r'), true)
    // 行が届いたら終わり（子プロセスが無いので exit は来ない。#375 と同じ判定）
    assert.deepEqual(app.settle(() => '2026-09-16T10:00:30Z'), ['S1@r'])
    assert.equal(app.running('S1@r'), false)

    // サーバが断ったら投げる（画面には 500 で理由が出る）
    status = 404
    now += 1000
    await assert.rejects(app.start({ id: 'S1@r', session: 'ses_none', text: 'x' }), /404.*session not found/)
    assert.equal(app.running('S1@r'), false, '送れていないものを処理中にしない')
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('skills: /command に cwd を渡して聞く。断られたら投げる（呼び出し側が空にする）', async () => {
  const seen: { url: string; auth: string }[] = []
  let status = 200
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization ?? '' })
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(
      status === 200
        ? JSON.stringify({ data: [{ name: 'demo-skill', description: 'プロジェクトのスキル', source: 'skill' }, { name: 'init', description: 'guided AGENTS.md setup', source: 'command' }] })
        : '{}',
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  try {
    const app = new OpencodeServer(fetch, Date.now, async () => ({ url: base, auth: 'Basic dGVzdA==' }))
    const skills = await app.skills('/w/some repo')
    assert.equal(seen[0]!.url, '/command?directory=%2Fw%2Fsome%20repo', 'cwd は escape して渡す（空白の入ったパスがある）')
    assert.equal(seen[0]!.auth, 'Basic dGVzdA==')
    assert.deepEqual(skills, [
      { name: 'demo-skill', description: 'プロジェクトのスキル', source: 'user' },
      { name: 'init', description: 'guided AGENTS.md setup', source: 'command' },
    ])
    status = 401
    await assert.rejects(app.skills('/w'), /401/)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('models: /config/providers に cwd を渡して聞く。断られたら投げる', async () => {
  const seen: { url: string; auth: string }[] = []
  let status = 200
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization ?? '' })
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(
      status === 200
        ? JSON.stringify({
            providers: [
              { id: 'openai', models: { 'gpt-6-astra': {} } },
              { id: 'ollama', models: { 'qwen3:8b': {} } },
            ],
          })
        : '{}',
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  try {
    const app = new OpencodeServer(fetch, Date.now, async () => ({ url: base, auth: 'Basic dGVzdA==' }))
    assert.deepEqual(await app.models('/w/some repo'), ['openai/gpt-6-astra', 'ollama/qwen3:8b'])
    assert.equal(seen[0]!.url, '/config/providers?directory=%2Fw%2Fsome%20repo')
    assert.equal(seen[0]!.auth, 'Basic dGVzdA==')
    status = 500
    await assert.rejects(app.models('/w'), /500/)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('permissions: directory を付けて引き、引けたかも返す（#421 / #422）', async () => {
  const seen: string[] = []
  /** `/w` には保留があり、`/ng` はエラーを返す */
  const server: Server = createServer((req, res) => {
    seen.push(req.url ?? '')
    if ((req.url ?? '').includes('%2Fng')) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('boom')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([{ id: 'per_1', sessionID: 'ses_1', permission: 'external_directory', patterns: ['/etc/*'], metadata: { filepath: '/etc/hosts' } }]))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  try {
    const app = new OpencodeServer(fetch, Date.now, async () => ({ url: base, auth: 'Basic dGVzdA==' }))
    const got = await app.permissions(['/w'])
    assert.deepEqual(seen, ['/permission?directory=%2Fw'], 'directory を渡す（渡さないと保留があっても空が返る）')
    assert.equal(got.ok, true)
    assert.equal(got.list.length, 1)
    assert.equal(got.list[0]?.id, 'per_1')

    // 1 つでも引けなければ ok: false（「保留が無い」と混ぜない。#422 で待ちを畳む材料になる）
    const partial = await app.permissions(['/w', '/ng'])
    assert.equal(partial.ok, false)
    assert.equal(partial.list.length, 1, '引けた分は返す')

    // 答えは v1 の口へ（`{"response":"once"}`）
    assert.equal(await app.answerPermission('ses_1', 'per_1', 'once'), true)
    assert.equal(seen.at(-1), '/session/ses_1/permissions/per_1')
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('permissions / answerPermission: サーバが立っていなければ起こさずに諦める（#421）', async () => {
  // `serveFn` を渡さない = 本物の spawn を通る実装。`live()` は立っているものだけを見るので、ここでは何も起こさない
  const app = new OpencodeServer()
  assert.deepEqual(await app.permissions(['/w']), { ok: false, list: [] }, '引けていない（保留が無い、ではない）')
  assert.equal(await app.answerPermission('ses_1', 'per_1', 'once'), false)
})

test('todos: 段取りとサブセッションの数を引く（#397）', async () => {
  const seen: string[] = []
  const server: Server = createServer((req, res) => {
    seen.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    if ((req.url ?? '').endsWith('/todo')) {
      // 実機（1.18.30）の形。**`id` は無い**
      res.end(JSON.stringify([
        { content: '調べる', status: 'completed', priority: 'medium' },
        { content: '直す', status: 'in_progress', priority: 'medium' },
      ]))
    } else {
      res.end(JSON.stringify([{ id: 'ses_child', parentID: 'ses_abc', title: 'math calculation (@general subagent)' }]))
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  try {
    const app = new OpencodeServer(fetch, Date.now, async () => ({ url: base, auth: 'Basic dGVzdA==' }))
    const got = await app.todos('ses_abc')
    assert.deepEqual(got.todos, [
      { content: '調べる', status: 'completed', priority: 'medium' },
      { content: '直す', status: 'in_progress', priority: 'medium' },
    ])
    assert.equal(got.children, 1, 'サブセッションはまず数だけ')
    assert.deepEqual(seen, ['/session/ses_abc/todo', '/session/ses_abc/children'])
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('todos: サーバが立っていなければ起こさない。片方が落ちてももう片方は返す（#397）', async () => {
  // `serveFn` を渡さない = 本物の spawn を通る実装。`live()` は立っているものだけを見るので何も起こさない（#421 と同じ）
  assert.deepEqual(await new OpencodeServer().todos('ses_abc'), { todos: [], children: 0 })

  const server: Server = createServer((req, res) => {
    if ((req.url ?? '').endsWith('/children')) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      return res.end('boom')
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([{ content: '直す', status: 'pending', priority: 'low' }]))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  try {
    const app = new OpencodeServer(fetch, Date.now, async () => ({ url: base, auth: 'Basic dGVzdA==' }))
    const got = await app.todos('ses_abc')
    assert.equal(got.todos.length, 1, '引けた方は出す')
    assert.equal(got.children, 0, '落ちた方は 0')
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('startSession: POST /session に directory を付けて作り、返る id を使う（#452）', async () => {
  const seen: { url: string; auth: string; body: unknown }[] = []
  let reply: { status: number; body: string } = { status: 200, body: JSON.stringify({ id: 'ses_new1', directory: '/work', title: 'x' }) }
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization ?? '', body: raw ? JSON.parse(raw) : null })
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(reply.body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  try {
    const app = new OpencodeServer(fetch, Date.now, async () => ({ url: base, auth: 'Basic dGVzdA==' }))
    assert.equal(await app.startSession('/work/dir one'), 'ses_new1')
    assert.equal(seen[0]!.url, '/session?directory=%2Fwork%2Fdir%20one', 'directory を付ける（渡さないとサーバの cwd で作られる）')
    assert.equal(seen[0]!.auth, 'Basic dGVzdA==')

    // 断られたら投げる（呼び出し側が 500 で理由を出す）
    reply = { status: 500, body: 'boom' }
    await assert.rejects(app.startSession('/work'), /500.*boom/)
    // id を返さない応答も投げる（空の id でエンティティIDを作らない）
    reply = { status: 200, body: JSON.stringify({ title: 'no id' }) }
    await assert.rejects(app.startSession('/work'), /セッションID/)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('stop: 止めたあとは serve を起こさない（C-c のあとに来たリクエストで孤児を作らない。#457）', async () => {
  let spawned = 0
  const app = new OpencodeServer(fetch, Date.now, async () => {
    spawned++
    return { url: 'http://127.0.0.1:1', auth: 'Basic dGVzdA==' }
  })
  app.stop()
  await assert.rejects(app.start({ id: 'S1@r', session: 'ses_abc', text: 'x' }), /opencode serve は起こしません/)
  await assert.rejects(app.skills('/work'), /起こしません/)
  await assert.rejects(app.models('/work'), /起こしません/)
  await assert.rejects(app.startSession('/work'), /起こしません/)
  assert.equal(spawned, 0, 'serve を起こしていない')
  assert.equal(app.running('S1@r'), false)
})
