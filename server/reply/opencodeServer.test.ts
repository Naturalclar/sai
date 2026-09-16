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
