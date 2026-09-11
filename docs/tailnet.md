# tailnet に出す（Tailscale Serve）

iPad やスマホから SAI を見るときの手順と、Serve のヘッダを信じずに本人を確かめる仕組み。セットアップは [README](../README.md)。

iPad やスマホから見たいときは **Tailscale Serve** で tailnet 内にだけ出す。アプリの bind は `127.0.0.1` のまま（Serve が前段で TLS を受けて 127.0.0.1 にプロキシする）。`tailscale funnel`（インターネット公開）は使わない。

```
tailscale serve --bg 8787                 # https://<このマシン>.<tailnet>.ts.net/ → 127.0.0.1:8787
tailscale serve status                    # 出ているものの確認
tailscale serve --bg 8787 off             # やめる
```

Serve 経由のリクエストには `Tailscale-User-Login`（誰か）と `X-Forwarded-For`（tailnet 側のアドレス）が付く。サーバはこのヘッダを**そのまま信じず**、`tailscale whois <X-Forwarded-For>` でローカルの Tailscale デーモンに本人を引き直し、一致したときだけ通す（`server/auth.ts`）。一致しなければ `401`。通ったログイン名は `/api/health` と一覧の `viewer` に載り、画面右上の自分のメニューに出る。

**ヘッダがどちらも無い**リクエストだけを、ループバックからの直アクセスとして通す。**`X-Forwarded-For` があるのに `Tailscale-User-Login` が無い**ものは Serve を通ったのに身元のヘッダが無いリクエストで、**タグ付きの端末から**来ている（Serve はタグ付きの端末に identity ヘッダを付けない）。Serve は `127.0.0.1` から繋ぐのでソケットだけではローカルと区別が付かず、前はそのまま通していた（#312）。いまは whois で引き、タグ付きの端末なら「タグ付き」として画面・REST は `401`、capability を与えた `/mcp`（下）だけ使える。タグ付きでなければ `401`。

同じホスト上から偽のヘッダを付けても通らないことは、こう確かめる（`401` になるのが正しい。`200` なら二段構えが効いていない）:

```
curl -H 'Tailscale-User-Login: someone@example.com' http://127.0.0.1:8787/api/health
```

`whois` の結果はアドレスごとに 30 秒キャッシュする（capability も同じ。grants を変えたら 30 秒で効く）（3 秒ごとのポーリングで毎回デーモンに聞かない）。`tailscale` の実行ファイルはサーバの PATH、無ければ macOS の GUI 版（`/Applications/Tailscale.app/Contents/MacOS/Tailscale`）。別の場所にあるならサーバの PATH に足す（前の `SAI_TAILSCALE_BIN` は #288 でやめた）。Serve 経由だとブラウザの `Origin` は `https://<MagicDNS 名>` になるので、書き込みの同一オリジン検査は Serve が付ける `X-Forwarded-Proto` でスキームを合わせる。

## tailnet から MCP で呼ぶ（#312）

tailnet 内の別のマシンで動いている Claude Code / Codex のセッションや、tailnet 内の別のサイトから、SAI を MCP で呼べる。口は `POST /mcp`（Streamable HTTP。1 通受けて JSON で 1 回返す最小の形で、SSE とセッションは無し）。Serve の URL にそのまま付ける:

```
https://<SAI のマシン>.<tailnet>.ts.net/mcp
```

### 呼ぶ側の設定

HTTP の MCP を話せる CLI はそのまま足す:

```
claude mcp add --transport http sai https://<SAI のマシン>.<tailnet>.ts.net/mcp
codex mcp add sai --url https://<SAI のマシン>.<tailnet>.ts.net/mcp
```

stdio しか置けない環境では、中継の `feed/mcp/sai-mcp.mjs`（依存ゼロ、Node 18+）をそのマシンに 1 ファイルだけ置く。受けた JSON-RPC を `/mcp` に POST して返すだけで、ツールも認可も SAI 側が決める:

```
claude mcp add sai -- node /path/to/sai-mcp.mjs https://<SAI のマシン>.<tailnet>.ts.net/mcp
codex mcp add sai -- node /path/to/sai-mcp.mjs https://<SAI のマシン>.<tailnet>.ts.net/mcp
```

どちらも**呼ぶ側の端末の tailnet の身元**で Serve を通るので、鍵は要らない。

### ツールと、誰に何を許すか

| ツール | まとまり | 中身 |
| --- | --- | --- |
| `sai_sessions` | `read` | 直近 7 日のセッションの一覧（id・呼び名・リポジトリ・処理中か・待ち（許可・質問）・送れない理由・最後の記録の時刻・最後の発言の 1 行目） |
| `sai_session` | `read` | そのセッションの直近のやりとり（既定 3 ターン、長いものは切る） |
| `sai_progress` | `read` | 処理中のターンがいま何をしているか（#302） |
| `sai_send` | `send` | 別のセッションに頼む・聞く（相手が処理中なら終わってから回る） |
| `sai_wait` | `send` | `sai_send` の返答を待つ（最大 120 秒。まだならもう一度呼ぶ） |

- **ループバックからの直アクセスと tailnet のユーザーは `read` だけ**（画面で見られる範囲と同じ）
- **`send` と、タグ付きの端末からの呼び出しは、tailnet の ACL（grants）で capability を与えたときだけ**。SAI は `tailscale whois` の `CapMap` を読む（Serve の `Tailscale-App-Capabilities` ヘッダは見ない）ので、`tailscale serve --accept-app-caps` は要らない
- ブラウザ（tailnet 内の別サイトのページ）から呼ぶときは、**そのページの Origin を capability の `origins` に書く**。書いていない Origin は `403` で、CORS もそれにだけ返す（ループバックからでも、Origin 付きは通さない）

grants の例（tailnet の管理画面の Access controls）:

```json
"grants": [
  {
    "src": ["autogroup:member"],
    "dst": ["<SAI のマシン>"],
    "app": {
      "github.com/naturalclar/sai/cap/mcp": [{ "tools": ["read", "send"], "origins": ["https://dash.<tailnet>.ts.net"] }]
    }
  },
  {
    "src": ["tag:ci"],
    "dst": ["<SAI のマシン>"],
    "app": { "github.com/naturalclar/sai/cap/mcp": [{ "tools": ["read"] }] }
  }
]
```

### 送るときの決まり

`sai_send` は、SAI が起動したセッション同士のメッセージ（#310）と同じ仕組みに乗る。相手の入力には `【SAI】tailnet の「<ログイン名>」からのメッセージです（id: …）` の見出しが付き、相手のそのターンの最後の発言が `sai_wait` に返る。

- **素通し（`bypassPermissions`）を選んだセッションには送れない**（呼んだ側の LLM が、許可を聞かないエージェントを動かせてしまう）
- アーカイブ済み・別のマシン・合成 ID など、画面から返信できないセッションにも送れない
- 1 人が送れるのは 10 分に 5 回まで。受け取ったメッセージで回っているターンから、さらに別のセッションへは送らせない（連鎖 1 段）
- セッション同士のメッセージ（#311）と同じく、**相手のエージェントの使用量の枠が 5 時間 80%・週 95% を超えていれば送らない**。相手に読み直させる量（相手の直近の呼び出しの入力）も足していき、10 分の区切りごとに 300 万トークンの予算を超える相手には送らない。`sai_send` の返事に相手が読み直す量と予算の残りが出る
- 送った記録はメモリだけ。SAI を立て直すと `sai_wait` は見失う（相手のターンはそのまま回る）

### 気をつけること

- **`read` のツールが返すのは作業の本文そのもの**。「SAI は外に出さない」の範囲は tailnet までだが、ツールで読んだ本文は**呼んだ側のエージェントの LLM（Anthropic / OpenAI など）に送られる**
- `send` を与えると、tailnet のその端末から SAI のセッションに作業を頼めるようになる（相手のエージェントが相手の `cwd` で動く）。与える相手を絞る
