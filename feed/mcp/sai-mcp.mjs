#!/usr/bin/env node
// 呼ぶ側のマシンで動かす stdio の MCP サーバ（#312 の B）。
// Claude Code / Codex からは普通の stdio の MCP サーバに見え、受けた JSON-RPC をそのまま SAI の `/mcp`
// （tailnet の Serve の URL）に POST して、返ってきたものを stdout に書く。
// **ツールの一覧も認可も SAI 側（`/mcp`）が決める**。ここは中継だけで、何も足さない・削らない
// （呼ぶ側の端末の tailnet の身元で Serve を通るので、SAI はその端末に与えた capability でツールを絞る）。
//
// 依存ゼロ・Node 18+（fetch）。このファイル 1 つを呼ぶ側のマシンに置けばよい:
//
//   claude mcp add sai -- node /path/to/sai-mcp.mjs https://<SAI のマシン>.<tailnet>.ts.net/mcp
//   codex mcp add sai -- node /path/to/sai-mcp.mjs https://<SAI のマシン>.<tailnet>.ts.net/mcp
//
// stdout は MCP の配線そのものなので、ログは stderr にだけ書く。
import { pathToFileURL } from 'node:url'

const log = (message) => process.stderr.write(`[sai-mcp] ${message}\n`)

/** SSE の本文から `data:` の中身（JSON の文字列）を取り出す。イベントは空行で区切られ、`data:` が複数行ならつなぐ */
export function sseMessages(text) {
  const out = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (data.trim()) out.push(data)
  }
  return out
}

/** 中継 1 本ぶんの状態。initialize の応答で決まった版と、サーバが返したセッション ID を以後のリクエストに付ける */
export function createBridge(target, write, fetchFn = fetch) {
  let protocolVersion = ''
  let sessionId = ''

  const errorFor = (id, message) => (id === undefined || id === null ? null : { jsonrpc: '2.0', id, error: { code: -32000, message } })

  return async function forward(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      log(`壊れた行: ${line.slice(0, 80)}`)
      return
    }
    const id = message && typeof message === 'object' ? message.id : undefined
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion
    if (sessionId) headers['Mcp-Session-Id'] = sessionId
    let res
    try {
      res = await fetchFn(target, { method: 'POST', headers, body: JSON.stringify(message) })
    } catch (err) {
      const reply = errorFor(id, `SAI に届きません（${target}）: ${err instanceof Error ? err.message : String(err)}`)
      if (reply) write(reply)
      return
    }
    const returnedSession = res.headers.get('mcp-session-id')
    if (returnedSession) sessionId = returnedSession
    const body = await res.text()
    if (res.status === 202 || !body.trim()) {
      if (!res.ok) {
        const reply = errorFor(id, `SAI が受け付けませんでした: HTTP ${res.status}`)
        if (reply) write(reply)
      }
      return
    }
    const type = res.headers.get('content-type') ?? ''
    const payloads = type.includes('text/event-stream') ? sseMessages(body) : [body]
    for (const payload of payloads) {
      let parsed
      try {
        parsed = JSON.parse(payload)
      } catch {
        parsed = null
      }
      if (parsed && typeof parsed === 'object' && parsed.jsonrpc === '2.0') {
        if (parsed.id === id && typeof parsed.result?.protocolVersion === 'string' && message.method === 'initialize') protocolVersion = parsed.result.protocolVersion
        write(parsed)
        continue
      }
      // JSON-RPC ではない失敗（401 / 403 / 405 など。SAI は { error } を返す）
      let reason = payload.trim().slice(0, 300)
      try {
        const e = JSON.parse(payload)
        if (typeof e?.error === 'string') reason = e.error
      } catch {
        // そのまま
      }
      const reply = errorFor(id, `SAI が受け付けませんでした: HTTP ${res.status} ${reason}`)
      if (reply) write(reply)
    }
  }
}

function main() {
  const target = process.argv[2] ?? ''
  if (!/^https?:\/\/\S+$/.test(target)) {
    log('使い方: node sai-mcp.mjs https://<SAI のマシン>.<tailnet>.ts.net/mcp')
    process.exit(2)
  }
  const forward = createBridge(target, (msg) => process.stdout.write(JSON.stringify(msg) + '\n'))
  const inflight = new Set()
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      // 待つツール（sai_wait）が長くかかっても他の要求を止めないように、並べて投げる
      const p = forward(line).catch((err) => log(`失敗: ${err instanceof Error ? err.message : String(err)}`))
      inflight.add(p)
      void p.finally(() => inflight.delete(p))
    }
  })
  process.stdin.on('end', () => {
    void Promise.allSettled([...inflight]).then(() => process.exit(0))
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
