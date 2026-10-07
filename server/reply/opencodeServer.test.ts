// #382。`opencode` のバイナリには触らず、**本物の HTTP サーバ**を立てて送り先の形を確かめる
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPENCODE_CONTEXT_MESSAGES, OpencodeServer, isServeProcess, listeningUrl, promptBody } from './opencodeServer.ts'

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

test('context: 末尾のメッセージだけ引き、入力の量が 0 でない一番新しい返答の入力 3 つの和を返す（#396）', async () => {
  const seen: string[] = []
  const server: Server = createServer((req, res) => {
    seen.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    // 実機（1.18.30）の形。書いている最中の assistant は全部 0 で届く
    res.end(JSON.stringify([
      { info: { role: 'assistant', tokens: { total: 12847, input: 12749, output: 93, reasoning: 0, cache: { read: 5, write: 3 } } }, parts: [] },
      { info: { role: 'user' }, parts: [] },
      { info: { role: 'assistant', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] },
    ]))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  try {
    const app = new OpencodeServer(fetch, Date.now, async () => ({ url: base, auth: 'Basic dGVzdA==' }))
    assert.equal(await app.context('ses_abc'), 12749 + 5 + 3)
    assert.deepEqual(seen, [`/session/ses_abc/message?limit=${OPENCODE_CONTEXT_MESSAGES}`])
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('context: サーバが立っていなければ起こさずに 0。断られても 0（#396）', async () => {
  assert.equal(await new OpencodeServer().context('ses_abc'), 0)
  const server: Server = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  try {
    assert.equal(await new OpencodeServer(fetch, Date.now, async () => ({ url: base, auth: 'Basic dGVzdA==' })).context('ses_nope'), 0)
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

test('fork: POST /session/<id>/fork に directory を付けて分岐し、返る id を使う（#398）', async () => {
  const seen: { method: string; url: string; auth: string; body: unknown }[] = []
  let reply: { status: number; body: string } = { status: 200, body: JSON.stringify({ id: 'ses_fork1', directory: '/work', title: 'x (fork #1)' }) }
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization ?? '', body: raw ? JSON.parse(raw) : null })
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(reply.body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  try {
    const app = new OpencodeServer(fetch, Date.now, async () => ({ url: base, auth: 'Basic dGVzdA==' }))
    assert.equal(await app.fork('ses_src', '/work/dir one'), 'ses_fork1')
    assert.deepEqual([seen[0]!.method, seen[0]!.url, seen[0]!.auth], ['POST', '/session/ses_src/fork?directory=%2Fwork%2Fdir%20one', 'Basic dGVzdA=='])
    assert.deepEqual(seen[0]!.body, {}, '末尾から分ける（messageID は渡さない）')
    // 知らないセッションは 404（呼び出し側が 500 で理由を出す）
    reply = { status: 404, body: JSON.stringify({ name: 'NotFoundError', data: { message: 'Session not found: ses_src' } }) }
    await assert.rejects(app.fork('ses_src', '/work'), /404.*Session not found/)
    // id を返さない・元と同じ id を返す応答は投げる（分岐できていないのに、元のセッションに送らない）
    reply = { status: 200, body: JSON.stringify({ title: 'no id' }) }
    await assert.rejects(app.fork('ses_src', '/work'), /分岐先のセッションID/)
    reply = { status: 200, body: JSON.stringify({ id: 'ses_src' }) }
    await assert.rejects(app.fork('ses_src', '/work'), /分岐先のセッションID/)
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
  await assert.rejects(app.fork('ses_abc', '/work'), /起こしません/)
  assert.equal(spawned, 0, 'serve を起こしていない')
  assert.equal(app.running('S1@r'), false)
})

test('abort: 回しているターンだけ /session/<id>/abort で止め、処理中から外す（#392）', async () => {
  const seen: { method: string; url: string; auth: string }[] = []
  let abortStatus = 200
  const server: Server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization ?? '' })
      if (req.url?.endsWith('/prompt_async')) {
        res.writeHead(204)
        return res.end()
      }
      // 本物（1.18.30）は回っていないセッションにも知らないセッションにも true を返す。返り値は当てにしない
      res.writeHead(abortStatus, { 'content-type': 'application/json' })
      res.end(abortStatus === 200 ? 'true' : 'boom')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  try {
    const app = new OpencodeServer(fetch, Date.now, async () => ({ url: base, auth: 'Basic dGVzdA==' }))

    // 回していないものは投げずに false（abort が true を返しても「止めた」にしない）
    assert.equal(await app.abort('S1@r'), false)
    assert.equal(seen.length, 0, '回していないセッションには投げない')

    await app.start({ id: 'S1@r', session: 'ses_abc', text: '長いターン' })
    assert.equal(app.replying()['S1@r']?.interruptible, true, 'prompt_async が通った時点で止められる（画面のボタンが出る）')

    // サーバが断ったら投げ、処理中のまま（止まったとは言わない）
    abortStatus = 500
    await assert.rejects(app.abort('S1@r'), /500/)
    assert.equal(app.running('S1@r'), true)

    abortStatus = 200
    assert.equal(await app.abort('S1@r'), true)
    const last = seen.at(-1)!
    assert.deepEqual([last.method, last.url, last.auth], ['POST', '/session/ses_abc/abort', 'Basic dGVzdA=='], 'エンティティIDではなく OpenCode のセッションIDで、鍵つきで止める')
    assert.equal(app.running('S1@r'), false, '行（本文の空の session.idle）を待たずに処理中から外す')
    assert.equal(app.replying()['S1@r'], undefined)

    // 2 回目は投げない（もう回していない）
    const before = seen.length
    assert.equal(await app.abort('S1@r'), false)
    assert.equal(seen.length, before)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('abort: サーバが立っていなければ起こさずに false（#392）', async () => {
  // `serveFn` を渡さない = 本物の spawn を通る実装。`live()` は立っているものだけを見るので何も起こさない
  assert.equal(await new OpencodeServer().abort('S1@r'), false)
})

test('abort: 回していたのにサーバがもう居なければ、処理中から外して止まった扱いにする（#488 のレビュー）', async () => {
  const server: Server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(204)
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  let alive = true
  try {
    const app = new OpencodeServer(fetch, Date.now, async () => {
      if (!alive) throw new Error('opencode serve がもう居ない')
      return { url: base, auth: 'Basic dGVzdA==' }
    })
    await app.start({ id: 'S1@r', session: 'ses_abc', text: '長いターン' })
    alive = false
    // false を返すと画面は「起動した直後なので止められない」の 409 になり、効かない「止める」と「処理中」が残り続けた
    assert.equal(await app.abort('S1@r'), true)
    assert.equal(app.running('S1@r'), false)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

/**
 * 鍵の要る本物の HTTP サーバ。受けたリクエストを覚える（引き取った `opencode serve` の代わり）。
 * `busy` に入っているセッションだけ `/session/status` に回っていると答える（1.18.30 の形。`/session/<id>` は directory を返す）
 */
async function authedServer(password: string, busy: Set<string> = new Set()) {
  const got: { method: string; url: string; auth: string }[] = []
  const server: Server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      got.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization ?? '' })
      const ok = req.headers.authorization === `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
      if (!ok) return res.end('{}')
      const path = (req.url ?? '').split('?')[0]!
      if (path === '/session/status') return res.end(JSON.stringify(Object.fromEntries([...busy].map((id) => [id, { type: 'busy' }]))))
      if (req.method === 'GET' && path.startsWith('/session/')) return res.end(JSON.stringify({ id: path.slice(9), directory: '/work' }))
      res.end('true')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  return { server, got, url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` }
}

test('立て直し: 前の SAI が残した opencode serve を引き取り、回していたターンを処理中のまま止められる（#440）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-oc-serve-'))
  const statePath = join(dir, 'opencode-serve.json')
  const { server, got, url } = await authedServer('pw-1', new Set(['ses_abc']))
  const killed: number[] = []
  try {
    await writeFile(statePath, JSON.stringify({ pid: 4242, url, password: 'pw-1', turns: { 'E@r': { since: '2026-09-30T10:00:00.000Z', text: '長いターン', session: 'ses_abc' } } }))
    const app = new OpencodeServer(fetch, Date.now, undefined, { statePath, logPath: join(dir, 'log'), alive: (pid) => pid === 4242, kill: (pid) => killed.push(pid) })
    await app.adopted
    assert.equal(app.running('E@r'), true, '本体がいまも回しているターンは処理中のまま（画面の「処理中」と預かりが続く）')
    assert.ok(got.some((g) => g.url === '/session/status?directory=%2Fwork'), 'セッションの directory を引いてから聞く')
    assert.equal(app.replying()['E@r']?.interruptible, true)
    // 引き取ったサーバに、残した鍵で届く
    assert.equal(await app.abort('E@r'), true)
    assert.deepEqual(got.at(-1), { method: 'POST', url: '/session/ses_abc/abort', auth: `Basic ${Buffer.from('opencode:pw-1').toString('base64')}` })
    assert.equal(app.running('E@r'), false)
    // 回していないときの C-c は今までどおり落とす（#457。渡したものも溜まらない）
    app.stop()
    assert.deepEqual(killed, [4242])
    await assert.rejects(stat(statePath), '落としたらファイルも消す')
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('立て直し: ターンを回している間の C-c では落とさず、次の SAI に渡す（#440）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-oc-serve-'))
  const statePath = join(dir, 'opencode-serve.json')
  const { server, url } = await authedServer('pw-2', new Set(['ses_x']))
  const killed: number[] = []
  try {
    await writeFile(statePath, JSON.stringify({ pid: 5151, url, password: 'pw-2', turns: {} }))
    const deps = { statePath, logPath: join(dir, 'log'), alive: (pid: number) => pid === 5151, kill: (pid: number) => killed.push(pid) }
    const first = new OpencodeServer(fetch, Date.now, undefined, deps)
    await first.start({ id: 'E@r', session: 'ses_x', text: '回っている' })
    first.stop()
    assert.deepEqual(killed, [], '回しているので落とさない')
    const kept = JSON.parse(await readFile(statePath, 'utf-8')) as { pid: number; turns: Record<string, { session: string }> }
    assert.equal(kept.pid, 5151)
    assert.equal(kept.turns['E@r']?.session, 'ses_x', '回しているターンも渡す')
    const second = new OpencodeServer(fetch, Date.now, undefined, deps)
    await second.adopted
    assert.equal(second.running('E@r'), true, '次の SAI が引き取る')
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('立て直し: 残した pid が死んでいれば引き取らず、ファイルを消す（#440）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-oc-serve-'))
  const statePath = join(dir, 'opencode-serve.json')
  try {
    await writeFile(statePath, JSON.stringify({ pid: 6161, url: 'http://127.0.0.1:9', password: 'x', turns: { 'E@r': { since: 'x', text: 'x', session: 's' } } }))
    const app = new OpencodeServer(fetch, Date.now, undefined, { statePath, logPath: join(dir, 'log'), alive: () => false, kill: () => assert.fail('死んでいるものは落とさない') })
    assert.equal(app.running('E@r'), false, '死んだサーバのターンは処理中にしない')
    await assert.rejects(stat(statePath))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('立て直し: 起こした opencode serve は別の pgid で、待ち受け先は出力のファイルから読み、居場所を残す（#440）', async () => {
  // PATH の先頭に偽物の `opencode` を置く（待ち受けの行を出して眠るだけ）
  const dir = await mkdtemp(join(tmpdir(), 'sai-oc-spawn-'))
  const bin = join(dir, 'bin')
  const fake = join(bin, 'opencode')
  execFileSync('mkdir', ['-p', bin])
  await writeFile(fake, '#!/bin/sh\necho "opencode server listening on http://127.0.0.1:59999"\nexec sleep 30\n')
  await chmod(fake, 0o755)
  const savedPath = process.env.PATH
  process.env.PATH = `${bin}:${savedPath}`
  const statePath = join(dir, 'opencode-serve.json')
  const logPath = join(dir, 'opencode-serve.log')
  // 前の起動の出力が残っている（ログは切り詰めない）。ASCII でない文字があっても、新しく書かれた分を読み飛ばさない（#519 のレビュー）
  await writeFile(logPath, '前回の出力 opencode server listening on http://127.0.0.1:1\n'.repeat(5) + '日本語のログ\n'.repeat(50))
  const app = new OpencodeServer(fetch, Date.now, undefined, { statePath, logPath, alive: (pid) => { try { process.kill(pid, 0); return true } catch { return false } } })
  try {
    // 立てるだけの口は無いので、`/` の候補（起こしてから聞く）で起こす。聞いた先は偽物なので空が返る
    await app.skills('/tmp').catch(() => [])
    const kept = JSON.parse(await readFile(statePath, 'utf-8')) as { pid: number; url: string; password: string }
    assert.equal(kept.url, 'http://127.0.0.1:59999', '待ち受け先を出力のファイルから読んだ')
    assert.ok(kept.password.length > 0, '鍵も残す（引き取った SAI が同じ鍵で叩く）')
    assert.match(await readFile(logPath, 'utf-8'), /listening on/, '出力は pipe ではなくファイルへ')
    const pgid = (pid: number) => execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)]).toString().trim()
    assert.notEqual(pgid(kept.pid), pgid(process.pid), 'C-c の SIGINT を受けないよう、別の pgid で起こす')
    // 回していないので、止めれば落とす（#457）
    app.stop()
    await new Promise((r) => setTimeout(r, 300))
    assert.throws(() => process.kill(kept.pid, 0), '落ちた')
    await assert.rejects(stat(statePath))
  } finally {
    process.env.PATH = savedPath
    app.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('立て直し: 引き取ったターンのうち、本体がもう回していないものは処理中から外す（#519 のレビュー）', async () => {
  // 行が届かないまま残った「処理中」を立て直しのたびに持ち越すと、永久に消えず、C-c でも serve が落ちなくなる
  const dir = await mkdtemp(join(tmpdir(), 'sai-oc-serve-'))
  const statePath = join(dir, 'opencode-serve.json')
  const { server, url } = await authedServer('pw-3', new Set(['ses_live']))
  const killed: number[] = []
  try {
    const turn = (session: string) => ({ since: '2026-09-30T10:00:00.000Z', text: 'x', session })
    await writeFile(statePath, JSON.stringify({ pid: 7171, url, password: 'pw-3', turns: { 'LIVE@r': turn('ses_live'), 'STUCK@r': turn('ses_stuck') } }))
    const app = new OpencodeServer(fetch, Date.now, undefined, { statePath, logPath: join(dir, 'log'), alive: (pid) => pid === 7171, kill: (pid) => killed.push(pid) })
    await app.adopted
    assert.equal(app.running('LIVE@r'), true)
    assert.equal(app.running('STUCK@r'), false, '本体が回していないターンは外す')
    const kept = JSON.parse(await readFile(statePath, 'utf-8')) as { turns: Record<string, unknown> }
    assert.deepEqual(Object.keys(kept.turns), ['LIVE@r'], '残すファイルからも外す')
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('立て直し: 残した鍵で答えない serve（pid の使い回し・別物）は使わず、落としもしない（#519 のレビュー）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-oc-serve-'))
  const statePath = join(dir, 'opencode-serve.json')
  const { server, got, url } = await authedServer('ほかの鍵')
  const killed: number[] = []
  try {
    await writeFile(statePath, JSON.stringify({ pid: 8181, url, password: 'pw-old', turns: { 'E@r': { since: 'x', text: 'x', session: 'ses_a' } } }))
    const app = new OpencodeServer(fetch, Date.now, undefined, { statePath, logPath: join(dir, 'log'), alive: (pid) => pid === 8181, kill: (pid) => killed.push(pid) })
    await app.adopted
    assert.equal(app.running('E@r'), false, '確かめられない serve のターンは戻さない')
    await assert.rejects(stat(statePath), '残したファイルも捨てる')
    const before = got.length
    await app.abort('E@r')
    assert.equal(got.length, before, 'その serve には以後なにも送らない')
    app.stop()
    assert.deepEqual(killed, [], '別物かもしれないので落とさない')
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('isServeProcess: 生きていても opencode serve でなければ偽（pid の使い回しで無関係のプロセスを落とさない。#519 のレビュー）', () => {
  assert.equal(isServeProcess(process.pid), false, 'テストを回している node は opencode serve ではない')
  assert.equal(isServeProcess(2 ** 22 + 12345), false, '居ない pid')
})
