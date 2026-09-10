# tailnet に出す（Tailscale Serve）

iPad やスマホから SAI を見るときの手順と、Serve のヘッダを信じずに本人を確かめる仕組み。セットアップは [README](../README.md)。

iPad やスマホから見たいときは **Tailscale Serve** で tailnet 内にだけ出す。アプリの bind は `127.0.0.1` のまま（Serve が前段で TLS を受けて 127.0.0.1 にプロキシする）。`tailscale funnel`（インターネット公開）は使わない。

```
tailscale serve --bg 8787                 # https://<このマシン>.<tailnet>.ts.net/ → 127.0.0.1:8787
tailscale serve status                    # 出ているものの確認
tailscale serve --bg 8787 off             # やめる
```

Serve 経由のリクエストには `Tailscale-User-Login`（誰か）と `X-Forwarded-For`（tailnet 側のアドレス）が付く。サーバはこのヘッダを**そのまま信じず**、`tailscale whois <X-Forwarded-For>` でローカルの Tailscale デーモンに本人を引き直し、一致したときだけ通す（`server/auth.ts`）。一致しなければ `401`。ヘッダが無いリクエストはループバックからの直アクセスとして通す。通ったログイン名は `/api/health` と一覧の `viewer` に載り、画面右上の自分のメニューに出る。

同じホスト上から偽のヘッダを付けても通らないことは、こう確かめる（`401` になるのが正しい。`200` なら二段構えが効いていない）:

```
curl -H 'Tailscale-User-Login: someone@example.com' http://127.0.0.1:8787/api/health
```

`whois` の結果はアドレスごとに 30 秒キャッシュする（3 秒ごとのポーリングで毎回デーモンに聞かない）。`tailscale` の実行ファイルはサーバの PATH、無ければ macOS の GUI 版（`/Applications/Tailscale.app/Contents/MacOS/Tailscale`）。別の場所にあるならサーバの PATH に足す（前の `SAI_TAILSCALE_BIN` は #288 でやめた）。Serve 経由だとブラウザの `Origin` は `https://<MagicDNS 名>` になるので、書き込みの同一オリジン検査は Serve が付ける `X-Forwarded-Proto` でスキームを合わせる。
