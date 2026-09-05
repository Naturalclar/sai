// tailnet への公開（tailscale serve）に向けた認証層。
//
// アプリの bind は 127.0.0.1 のまま。Serve が前段で TLS を受けて 127.0.0.1 にプロキシし、
// そのとき `Tailscale-User-Login`（誰か）と `X-Forwarded-For`（tailnet 側のアドレス）を付ける。
// ヘッダは「誰かのヒント」でしかない（同じホスト上のプロセスなら好きに付けられる）ので、
// `tailscale whois <X-Forwarded-For>` でローカルの Tailscale デーモンに本人を引き直し、一致したときだけ信用する。
// 一致しなければ 401。ヘッダを黙って無視して通す実装にはしない。
// ヘッダが無いリクエストは、ループバックから来ていればローカルの直アクセスとして通す。
import { execFile } from 'node:child_process'
import type { IncomingMessage } from 'node:http'

/** 誰がアクセスしているか。local はローカルからの直アクセス（ヘッダ無し） */
export type Identity = { kind: 'local' } | { kind: 'tailnet'; login: string; name?: string }

/** tailnet 側のアドレスから、そのノードの持ち主のログイン名を引く。引けなければ null */
export type Whois = (addr: string) => Promise<string | null>

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** `tailscale whois --json` の出力からログイン名を取る。形が違えば null */
export function loginFromWhois(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { UserProfile?: { LoginName?: unknown } }
    const login = parsed?.UserProfile?.LoginName
    return typeof login === 'string' && login ? login : null
  } catch {
    return null
  }
}

/** tailscale の実行ファイル。PATH の `tailscale`、無ければ macOS の GUI 版。`SAI_TAILSCALE_BIN` で差し替え */
export function tailscaleBins(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.SAI_TAILSCALE_BIN) return [env.SAI_TAILSCALE_BIN]
  const bins = ['tailscale']
  if (process.platform === 'darwin') bins.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
  return bins
}

/** 実際に `tailscale whois --json <addr>` を叩く Whois。見つからなければ（peer not found、コマンドが無い）null */
export function tailscaleWhois(env: NodeJS.ProcessEnv = process.env): Whois {
  const bins = tailscaleBins(env)
  const run = (bin: string, addr: string) =>
    new Promise<string | null>((resolve, reject) => {
      execFile(bin, ['whois', '--json', addr], { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(err)
          return resolve(null) // peer not found などは exit 0 で stderr に出るが、非 0 でも「引けない」として扱う
        }
        resolve(loginFromWhois(stdout))
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
  login: string | null
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

  private async lookup(addr: string): Promise<string | null> {
    const now = Date.now()
    const hit = this.cache.get(addr)
    if (hit && hit.until > now) return hit.login
    this.calls++
    const login = await this.whois(addr)
    // 引けなかったときは短く覚える（デーモンが落ちている間に毎リクエスト叩かない）
    this.cache.set(addr, { login, until: now + (login ? this.ttlMs : Math.min(this.ttlMs, 5_000)) })
    return login
  }

  /** 誰か。null なら 401 にする */
  async identify(req: IncomingMessage): Promise<Identity | null> {
    const header = req.headers['tailscale-user-login']
    const login = typeof header === 'string' ? header.trim() : ''
    if (!login) {
      const remote = req.socket?.remoteAddress ?? ''
      return LOOPBACK.has(remote) ? { kind: 'local' } : null
    }
    const forwarded = req.headers['x-forwarded-for']
    const addr = (typeof forwarded === 'string' ? forwarded : '').split(',')[0]?.trim() ?? ''
    if (!addr) return null
    const actual = await this.lookup(addr)
    if (!actual || actual.toLowerCase() !== login.toLowerCase()) return null
    const nameHeader = req.headers['tailscale-user-name']
    const name = typeof nameHeader === 'string' && nameHeader.trim() ? nameHeader.trim() : undefined
    return name ? { kind: 'tailnet', login, name } : { kind: 'tailnet', login }
  }
}
