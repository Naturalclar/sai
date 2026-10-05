# tailnet の認証の仕組み（`server/auth.ts`）

CLAUDE.md から移した「どう動くか」。守る決まりは CLAUDE.md、経緯は [history/auth.md](../history/auth.md)。使う側の手順は [tailnet.md](../tailnet.md)。

- Serve の `Tailscale-User-Login` は `Authenticator` が `tailscale whois <X-Forwarded-For>` で突き合わせ、合わなければ全リクエスト 401。
- ヘッダがどちらも無いものは、接続元と `Host` がともにループバック（`127.0.0.1` / `localhost` / `[::1]`）のときだけ直アクセスとして通す。接続元だけでは DNS rebinding を見分けられないため、外の名前の `Host` は全ての口で 403 にする。
- `X-Forwarded-For` があるのに `Tailscale-User-Login` が無いのは Serve を通ったタグ付きの端末（Serve はタグ付きの端末に identity ヘッダを付けず、127.0.0.1 から繋ぐのでソケットではローカルと区別が付かない。#312）なので、whois で引いて `tagged` にし、画面・REST は 401、capability を与えた `/mcp` だけ通す。
- whois を聞けなかった（時間切れ・デーモンが答えない）ことと、「居ない・別人」と答えたことは分ける: `tailscaleWhois()` は前者で `WhoisUnavailable` を投げ、`Authenticator` は直前に確かめた本人を `WHOIS_STALE_MS`（5 分）まで使い続けて `WHOIS_RETRY_MS`（5 秒）後に聞き直す。後者はすぐ 401。`peer not found` は exit 1 で返るので stderr で分ける。
- 同じアドレスの whois は同時に 1 本だけ（走っている間のリクエストはその答えを待つ）。キャッシュの期限は答えが返った時刻から数える。
- テストは `createApp(..., auth)` で `Whois` を差し替える。
- Serve 経由は `Origin` が `https://` になるので、`isCrossOrigin()` は `X-Forwarded-Proto` を見る。
