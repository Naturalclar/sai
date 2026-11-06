// 受信箱のアダプター（#873）が ChatGPT の callback へ送る webhook。署名（Standard Webhooks）・送り先の検査・送る口。
//
// - 送り先は **https で、名前を引いた先が全部 public なアドレス**のときだけ。引いたアドレスに固定して繋ぐ（引き直さない。
//   検査のあとに名前の向きが変わっても private へは行かない）
// - 10 秒で見切る。リダイレクトは追わない（3xx は失敗として扱う）
// - テストは `Transport` と `Lookup` を偽物に差し替える（本物の OpenAI には繋がない）
import { createHmac } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'

export const WEBHOOK_TIMEOUT_MS = 10_000
/** 1 件の配信の上限（MCP Events の 256 KiB） */
export const WEBHOOK_MAX_BYTES = 256 * 1024
/** 応答の本文は challenge を読むのに要る分だけ読む */
const RESPONSE_MAX_BYTES = 64 * 1024

/** `whsec_<base64>` の鍵をバイト列に。形が違えば null */
export function secretBytes(secret: string): Buffer | null {
  const m = /^whsec_([A-Za-z0-9+/]+={0,2})$/.exec(secret)
  if (!m?.[1]) return null
  const b = Buffer.from(m[1], 'base64')
  return b.length >= 16 ? b : null
}

/**
 * Standard Webhooks の署名。`<id>.<秒>.<本文>` を鍵ごとに HMAC-SHA256 して `v1,<base64>` を空白で並べる
 * （鍵を替える途中は 2 つ並ぶ。受け手はどちらかが合えば通す）
 */
export function signWebhook(secrets: readonly string[], id: string, timestamp: number, body: string): string {
  return secrets
    .map((s) => secretBytes(s))
    .filter((b): b is Buffer => b !== null)
    .map((key) => `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`)
    .join(' ')
}

const v4 = (ip: string): number[] | null => {
  const p = ip.split('.').map(Number)
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null
}

/** IPv6 を 8 つの 16 ビットに開く（末尾の a.b.c.d も）。読めなければ null */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0] ?? ''
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (dotted?.[1]) {
    const p = v4(dotted[1])
    if (!p) return null
    s = s.slice(0, -dotted[1].length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const part = (h: string) => (h ? h.split(':').map((x) => parseInt(x, 16)) : [])
  const head = part(halves[0] ?? '')
  const tail = part(halves[1] ?? '')
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  const g = [...head, ...Array<number>(Math.max(fill, 0)).fill(0), ...tail]
  return g.length === 8 && g.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? g : null
}

/** private・ループバック・リンクローカル・CGNAT・マルチキャスト・予約など、外の送り先として受けないアドレスか */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) {
    const p = v4(ip)
    if (!p) return true
    const [a = 0, b = 0, c = 0] = p
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    )
  }
  if (kind === 6) {
    const g = v6Groups(ip)
    if (!g) return true
    const zeros = (n: number) => g.slice(0, n).every((x) => x === 0)
    // IPv4 を埋めた形（::ffff:a.b.c.d・::a.b.c.d。URL は ::ffff:7f00:1 の形に直す）は中の IPv4 で見る
    if ((zeros(5) && g[5] === 0xffff) || (zeros(6) && (g[6] !== 0 || (g[7] ?? 0) > 1))) {
      const [hi = 0, lo = 0] = g.slice(6)
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
    const [a = 0, b = 0] = g
    return (
      zeros(8) || // ::
      (zeros(7) && g[7] === 1) || // ::1
      (a & 0xfe00) === 0xfc00 || // fc00::/7
      (a & 0xffc0) === 0xfe80 || // fe80::/10
      (a & 0xff00) === 0xff00 || // マルチキャスト
      (a === 0x64 && b === 0xff9b) || // NAT64（中が private かもしれない）
      (a === 0x2001 && (b === 0 || b === 0xdb8)) || // Teredo・文書用
      a === 0x2002 // 6to4（中が private かもしれない）
    )
  }
  return true
}

/** 名前を引く。返すのはアドレスの並び */
export type Lookup = (host: string) => Promise<string[]>

export const realLookup: Lookup = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address)

/** 名前が引けなかった（一時的なことがあるので、配信では送り直す側に入れる） */
export const LOOKUP_FAILED = 'callback の名前を引けません'

export interface Target {
  url: URL
  /** 繋ぐアドレス（検査を通ったもの。引き直さない） */
  address: string
}

/** callback の URL を検査して、繋ぐ先を決める。だめなら理由（文字列） */
export async function resolveCallback(raw: string, lookup: Lookup): Promise<Target | string> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'callback の URL が読めません'
  }
  if (url.protocol !== 'https:') return 'callback は https でなければなりません'
  if (url.username || url.password) return 'callback の URL に利用者名・パスワードを入れないでください'
  if (url.hash) return 'callback の URL に # を入れないでください'
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let addresses: string[]
  try {
    addresses = isIP(host) ? [host] : await lookup(host)
  } catch {
    return LOOKUP_FAILED
  }
  if (addresses.length === 0) return LOOKUP_FAILED
  // 1 つでも private を指していれば送らない（どれに繋がるかを相手に選ばせない）
  if (addresses.some(isPrivateAddress)) return 'callback が private なアドレスを指しています'
  return { url, address: addresses[0]! }
}

export interface Sent {
  status: number
  body: string
}

/** 1 回送る。届かなかった・見切った・壊れた応答は throw */
export type Transport = (t: Target, headers: Record<string, string>, body: string, timeoutMs: number) => Promise<Sent>

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void

/**
 * 名前を引かずに、検査したアドレスを返す `lookup`。Node 22 は `autoSelectFamily` で `{ all: true }` を付けて呼び、
 * そのときは配列を求める（文字列を返すと `ERR_INVALID_IP_ADDRESS` で落ちる）ので、両方の形で返す
 */
export function pinnedLookup(address: string) {
  const family = isIP(address)
  return (_host: string, opts: { all?: boolean } | number | undefined, cb: LookupCallback): void => {
    if (typeof opts === 'object' && opts?.all) cb(null, [{ address, family }])
    else cb(null, address, family)
  }
}

/** 本物の送る口。検査を通ったアドレスに固定して https で繋ぐ（証明書は URL の名前で確かめる）。リダイレクトは追わない */
export const httpsTransport: Transport = (t, headers, body, timeoutMs) =>
  new Promise<Sent>((resolve, reject) => {
    const req = request(
      t.url,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
        lookup: pinnedLookup(t.address),
        servername: isIP(t.url.hostname) ? undefined : t.url.hostname,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size <= RESPONSE_MAX_BYTES) chunks.push(c)
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
        res.on('error', reject)
      },
    )
    // 繋ぐ・待つ全体を締め切る（`timeout` は無通信の時間だけなので別に持つ）
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs)
    req.on('close', () => clearTimeout(timer))
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(body)
  })

/** 送る直前に付けるヘッダ（Standard Webhooks） */
export function webhookHeaders(secrets: readonly string[], id: string, timestamp: number, body: string): Record<string, string> {
  return { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': signWebhook(secrets, id, timestamp, body) }
}
