// unix ソケットの上の最小の WebSocket 客（#848）。Codex の daemon の口がこの形で、Node の組み込みの `WebSocket` は unix ソケットを受けない。
// server/ は依存を足さないので、要る分（テキスト・ping / pong・close・分割された受信）だけを持つ。バイナリは読み捨てる
import { createHash, randomBytes } from 'node:crypto'
import { connect } from 'node:net'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** 1 つのメッセージの上限。超えたら読むのをやめて切る（相手は手元の daemon だが、際限なく溜めない） */
export const WS_MAX_MESSAGE_BYTES = 32 * 1024 * 1024
const OP_CONT = 0
const OP_TEXT = 1
const OP_CLOSE = 8
const OP_PING = 9
const OP_PONG = 10

export interface UnixWebSocket {
  send(text: string): void
  close(): void
}

/** クライアントのフレーム（必ずマスクする） */
export function encodeFrame(op: number, payload: Buffer): Buffer {
  const mask = randomBytes(4)
  const head =
    payload.length < 126
      ? Buffer.from([0x80 | op, 0x80 | payload.length])
      : payload.length < 65536
        ? Buffer.from([0x80 | op, 0x80 | 126, payload.length >> 8, payload.length & 255])
        : Buffer.concat([Buffer.from([0x80 | op, 0x80 | 127]), bigLength(payload.length)])
  const body = Buffer.from(payload)
  for (let i = 0; i < body.length; i++) body[i]! ^= mask[i % 4]!
  return Buffer.concat([head, mask, body])
}

const bigLength = (n: number) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(n))
  return b
}

/** `Sec-WebSocket-Accept` の期待値 */
export const acceptKey = (key: string) => createHash('sha1').update(key + GUID).digest('base64')

/**
 * 繋いで handshake まで待つ。101 でない・`Sec-WebSocket-Accept` が違う・`timeoutMs` で返らなければ reject。
 * 繋がったあとに切れたら `onClose` を 1 回呼ぶ（reject はしない）
 */
export function connectUnixWebSocket(path: string, on: { text: (text: string) => void; close: () => void }, timeoutMs = 5000): Promise<UnixWebSocket> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    const socket = connect(path)
    let buffer = Buffer.alloc(0)
    let open = false
    let closed = false
    let parts: Buffer[] = []
    let partBytes = 0
    const timer = setTimeout(() => fail(new Error('handshake timed out')), timeoutMs)
    const fail = (err: Error) => {
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    }
    const write = (op: number, payload: Buffer) => {
      if (!socket.destroyed) socket.write(encodeFrame(op, payload))
    }
    const frames = () => {
      for (;;) {
        if (buffer.length < 2) return
        const fin = (buffer[0]! & 0x80) !== 0
        const op = buffer[0]! & 15
        const masked = (buffer[1]! & 0x80) !== 0
        let length = buffer[1]! & 127
        let at = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          at = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          const big = buffer.readBigUInt64BE(2)
          if (big > BigInt(WS_MAX_MESSAGE_BYTES)) return void socket.destroy()
          length = Number(big)
          at = 10
        }
        // サーバからのフレームはマスクしない決まり
        if (masked || length > WS_MAX_MESSAGE_BYTES) return void socket.destroy()
        if (buffer.length < at + length) return
        const payload = buffer.subarray(at, at + length)
        buffer = buffer.subarray(at + length)
        if (op === OP_PING) write(OP_PONG, payload)
        else if (op === OP_CLOSE) return void socket.destroy()
        else if (op === OP_PONG) continue
        else if (op === OP_TEXT || op === OP_CONT) {
          partBytes += length
          if (partBytes > WS_MAX_MESSAGE_BYTES) return void socket.destroy()
          parts.push(Buffer.from(payload))
          if (fin) {
            const text = Buffer.concat(parts).toString('utf-8')
            parts = []
            partBytes = 0
            // 受け手が投げてもソケットのハンドラから抜けさせない（抜けるとサーバごと落ちる）。その 1 通を捨てるだけ
            try {
              on.text(text)
            } catch {
              /* 読み捨てる */
            }
          }
        }
      }
    }
    socket.on('connect', () => {
      socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    })
    socket.on('data', (chunk) => {
      buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk
      if (!open) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        const lines = buffer.subarray(0, end).toString('latin1').split('\r\n')
        const accept = lines.find((l) => /^sec-websocket-accept:/i.test(l))?.split(':')[1]?.trim()
        if (!/^HTTP\/1\.1 101 /.test(lines[0] ?? '') || accept !== acceptKey(key)) return fail(new Error(`handshake refused: ${(lines[0] ?? '').slice(0, 80)}`))
        open = true
        clearTimeout(timer)
        buffer = buffer.subarray(end + 4)
        resolve({
          send: (text) => write(OP_TEXT, Buffer.from(text, 'utf-8')),
          close: () => socket.destroy(),
        })
      }
      frames()
    })
    socket.on('error', (err) => {
      if (!open) fail(err)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      if (!open) return reject(new Error('closed before handshake'))
      if (closed) return
      closed = true
      on.close()
    })
  })
}
