// tailnet への公開（tailscale serve）に向けた認証層。
//
// アプリの bind は 127.0.0.1 のまま。Serve が前段で TLS を受けて 127.0.0.1 にプロキシし、
// そのとき `Tailscale-User-Login`（誰か）と `X-Forwarded-For`（tailnet 側のアドレス）を付ける。
// ヘッダは「誰かのヒント」でしかない（同じホスト上のプロセスなら好きに付けられる）ので、
// `tailscale whois <X-Forwarded-For>` でローカルの Tailscale デーモンに本人を引き直し、一致したときだけ信用する。
// 一致しなければ 401。ヘッダを黙って無視して通す実装にはしない。
//
// **Serve を通ったのに `Tailscale-User-Login` が無いリクエストは、ローカルの直アクセスではない**（#312）。
// Serve はタグ付きの端末から来たトラフィックには identity ヘッダを付けず、しかも 127.0.0.1 から繋ぐので、
// ソケットだけ見ると「ループバックからの直アクセス」と区別が付かない（前はそのまま通していた）。
// `X-Forwarded-For` があれば whois で引き、タグ付きの端末なら `tagged`（使えるのは capability を与えた MCP だけ）、それ以外は 401。
// ヘッダがどちらも無いリクエストだけを、ループバックからの直アクセスとして通す。
import { execFile } from 'node:child_process'
import type { IncomingMessage } from 'node:http'

/** tailnet の ACL（grants）でこのマシンに対して与えられた capability（`tailscale whois --json` の `CapMap`） */
export type CapMap = Record<string, unknown[]>

/**
 * 誰がアクセスしているか。
 * - `local`: ループバックからの直アクセス（Serve のヘッダ無し）
 * - `tailnet`: tailnet のユーザー（whois で確かめたログイン名）
 * - `tagged`: タグ付きの端末（ユーザーがいない）。画面・REST は使えず、capability を与えた MCP（`/mcp`）だけ
 */
export type Identity = { kind: 'local' } | { kind: 'tailnet'; login: string; name?: string; caps: CapMap } | { kind: 'tagged'; node: string; caps: CapMap }

/** `tailscale whois` で引けた相手 */
export interface WhoisInfo {
  /** ログイン名。タグ付きの端末は持ち主のユーザーがいないので、tailscale が付けた名前（`tagged-devices`）になる */
  login: string
  /** タグ付きの端末か（`Node.Tags` がある） */
  tagged: boolean
  /** 端末の名前（MagicDNS 名の先頭）。無ければ空 */
  node: string
  caps: CapMap
}

/** tailnet 側のアドレスから、そのノードの持ち主と capability を引く。引けなければ null */
export type Whois = (addr: string) => Promise<WhoisInfo | null>

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** `tailscale whois --json` の出力を読む。ログイン名もタグも無ければ（形が違う・peer not found）null */
export function whoisFromJson(json: string): WhoisInfo | null {
  try {
    const parsed = JSON.parse(json) as { UserProfile?: { LoginName?: unknown }; Node?: { Tags?: unknown; Name?: unknown }; CapMap?: unknown }
    const login = typeof parsed?.UserProfile?.LoginName === 'string' ? parsed.UserProfile.LoginName : ''
    const tags = parsed?.Node?.Tags
    const tagged = Array.isArray(tags) && tags.length > 0
    if (!login && !tagged) return null
    const caps: CapMap = {}
    const raw = parsed?.CapMap
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [name, values] of Object.entries(raw)) caps[name] = Array.isArray(values) ? values : []
    }
    const node = typeof parsed?.Node?.Name === 'string' ? (parsed.Node.Name.split('.')[0] ?? '') : ''
    return { login, tagged, node, caps }
  } catch {
    return null
  }
}

/** `tailscale whois --json` の出力からログイン名を取る。形が違えば null */
export function loginFromWhois(json: string): string | null {
  return whoisFromJson(json)?.login || null
}

/**
 * tailscale の実行ファイル。サーバの PATH の `tailscale`、無ければ macOS の GUI 版（CLI を PATH に入れていないことが多い）。
 * 前は `SAI_TAILSCALE_BIN` で差し替えられたが、PATH を渡せば同じなのでやめた（#288）
 */
export function tailscaleBins(platform: NodeJS.Platform = process.platform): string[] {
  const bins = ['tailscale']
  if (platform === 'darwin') bins.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
  return bins
}

/** 実際に `tailscale whois --json <addr>` を叩く Whois。見つからなければ（peer not found、コマンドが無い）null */
export function tailscaleWhois(): Whois {
  const bins = tailscaleBins()
  const run = (bin: string, addr: string) =>
    new Promise<WhoisInfo | null>((resolve, reject) => {
      execFile(bin, ['whois', '--json', addr], { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(err)
          return resolve(null) // peer not found などは exit 0 で stderr に出るが、非 0 でも「引けない」として扱う
        }
        resolve(whoisFromJson(stdout))
      })
    })
  return async (addr) => {
    for (const bin of bins) {
      try {
        return await run(bin, addr)
      } catch {
        // その実行ファイルが無い。次を試す
      }
    }
    return null
  }
}

interface Cached {
  info: WhoisInfo | null
  until: number
}

/**
 * リクエストごとに identify() を呼ぶ。whois の結果はアドレスごとに短くキャッシュする
 * （画面は 3 秒ごとにポーリングするので、毎回デーモンに聞きに行かない）
 */
export class Authenticator {
  private readonly whois: Whois
  private readonly ttlMs: number
  private readonly cache = new Map<string, Cached>()
  /** テスト用: whois を実際に呼んだ回数 */
  calls = 0

  constructor(whois: Whois, ttlMs = 30_000) {
    this.whois = whois
    this.ttlMs = ttlMs
  }

  private async lookup(addr: string): Promise<WhoisInfo | null> {
    const now = Date.now()
    const hit = this.cache.get(addr)
    if (hit && hit.until > now) return hit.info
    this.calls++
    const info = await this.whois(addr)
    // 引けなかったときは短く覚える（デーモンが落ちている間に毎リクエスト叩かない）
    this.cache.set(addr, { info, until: now + (info ? this.ttlMs : Math.min(this.ttlMs, 5_000)) })
    return info
  }

  /** 誰か。null なら 401 にする */
  async identify(req: IncomingMessage): Promise<Identity | null> {
    const header = req.headers['tailscale-user-login']
    const login = typeof header === 'string' ? header.trim() : ''
    const forwarded = req.headers['x-forwarded-for']
    const addr = (typeof forwarded === 'string' ? forwarded : '').split(',')[0]?.trim() ?? ''
    if (!login) {
      if (!LOOPBACK.has(req.socket?.remoteAddress ?? '')) return null
      if (!addr) return { kind: 'local' }
      // Serve を通ったのにユーザーのヘッダが無い。タグ付きの端末からなら tagged、そうでなければ通さない（#312）
      const info = await this.lookup(addr)
      return info?.tagged ? { kind: 'tagged', node: info.node, caps: info.caps } : null
    }
    if (!addr) return null
    const actual = await this.lookup(addr)
    if (!actual || actual.tagged || !actual.login || actual.login.toLowerCase() !== login.toLowerCase()) return null
    const nameHeader = req.headers['tailscale-user-name']
    const name = typeof nameHeader === 'string' && nameHeader.trim() ? nameHeader.trim() : undefined
    return name ? { kind: 'tailnet', login, name, caps: actual.caps } : { kind: 'tailnet', login, caps: actual.caps }
  }
}
