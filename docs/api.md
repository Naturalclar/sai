# エンドポイント

サーバが返す API と、集計・返信の実行の中身。セットアップは [README](../README.md)。

| | |
| --- | --- |
| `GET /` | ビューア（`web/dist/index.html`） |
| `GET /assets/*` | ビルド成果物。`dist/` の外には出ない |
| `GET /api/sessions?days=7&project=&repo=&agent=&date=&archived=` | セッション一覧（集計済み）。`record_version` は窓の中の一番新しい行の `v`（画面の「record.py が古い」の判定）。各セッションの `waiting` は人を待って止まっていれば「何を待っているか」、そうでなければ空。`filters` に絞り込み候補、`replying` に処理中の返信（ID → `{ since, text }`）、`approvals` に返信中のエージェントが待っている許可・質問（ID → 古い順の配列）、`profile` に自分の表示名とアイコンも返す。既定ではアーカイブ済みを除き、`archived=1` でアーカイブ済みだけ（`total` と `filters` もその集合から）。`viewer` は tailnet 経由ならログイン名、直アクセスなら `null` |
| `GET /api/health` | `{ ok: true, viewer }`。認証の確認にも使う（偽ヘッダで `401` になること） |
| `GET /api/sessions/<id>?days=30` | そのエンティティの全行と `replying`。`<id>` は `<セッション>@<リポジトリ>` |
| `POST /api/sessions/<id>/reply?days=90` | body `{ "text": "..." }`。そのセッションを `cwd` で再開して1ターン回すのを投げっぱなしにし、`202` を返す。合成 ID は `400`、進行中は `409`、別オリジンは `403` |
| `POST /api/approvals` | 返信中の CLI（`server/approve-mcp.ts`）が許可・質問を預ける。body `{ "id", "tool_name", "input", "tool_use_id"? }`。返信を処理中でないエンティティは `409`。`201` で `{ "approval_id" }` |
| `GET /api/approvals/<approval_id>?wait=1` | 答えが付いていれば `200` で `{ "behavior": "allow" \| "deny", "updatedInput"?, "message"? }`（渡したら消える）。まだなら `wait=1` で最大 20 秒待って `202`。無ければ `404` |
| `POST /api/approvals/<approval_id>/answer` | 画面から答える。body `{ "behavior": "allow" \| "deny", "updatedInput"?, "message"? }`。`allow` で `updatedInput` を省けば元の入力のまま。別オリジンは `403`、答え済みは `404` |
| `GET /api/sessions/<id>/skills?days=90` | `/` の候補になるスキル。`{ "id", "skills": [{ "name", "description", "source": "user" \| "project" }] }`。`~/.claude/skills/` とセッションの `cwd` の `.claude/skills/` から集め、プロジェクト側を先に、同じ名前はプロジェクトが勝つ。Claude 以外は空。窓の中に無いセッションは `404` |
| `GET /api/sessions/<id>/permissions?days=90` | そのセッションの `cwd` に効いている許可ルール。`{ "id", "cwd", "agent", "mode", "sources", "rules" }`。`rules` は評価順（`deny` → `ask` → `allow`）。**読むだけ**で、パスは `cwd` から固定で組み立てる。Codex は `sources` / `rules` とも空 |
| `GET /api/sessions/<id>/diff?base=&days=90` | そのセッションの worktree の差分（`git` を読むだけ）。`branch` が `base...HEAD`、`working` が未コミット、`untracked` は追跡外のファイル名。大きすぎれば `truncated`。`cwd` が git のリポジトリでなければ `404` |
| `GET /api/sessions/<id>/meta` | 表示名・アーカイブ・返信のモデル・一言の性格。`{ "id", "meta": { "name"?, "archived_at"?, "model"?, "persona"? } }`。無ければ `meta` は `{}` |
| `PUT /api/sessions/<id>/meta?days=90` | body `{ "name"?: "...", "archived_at"?: "<ISO>", "model"?: "opus", "persona"?: "ISTJ", "permission_mode"?: "acceptEdits" }` をいまの値に重ねる。省略したキーは据え置き、空文字や `null` は「消す」で、全部消えたらエントリごと消える。知らないキーは捨てる。名前は100文字まで、`archived_at` は読める時刻、`model` は英数字で始まる 64 文字までの名前、`persona` は `shared/persona.ts` にある id、`permission_mode` は `acceptEdits` だけ（違えば `400`）。窓の中に無いセッションは `404`、別オリジンは `403` |
| `GET /api/sessions/<id>/icon?v=<mtime>` | アイコン画像そのもの（`image/png` など）。無ければ `404`。`v` がいまのファイルと同じなら `Cache-Control: immutable`、無ければ `no-store` |
| `PUT /api/sessions/<id>/icon?days=90` | body は画像そのもの（PNG / JPEG / GIF / WebP、1MB まで。種類は中身で見る。画面からは加工後の 256px の PNG が来る）。`{ "id", "icon": "<URL>" }` を返す。画像でなければ `400`、大きすぎれば `413`、窓の中に無いセッションは `404`、別オリジンは `403` |
| `DELETE /api/sessions/<id>/icon` | 画像を消す。`{ "id", "icon": null }`。無くても `200`。別オリジンは `403` |
| `GET /api/profile` | 自分の表示名とアイコン。`{ "profile": { "name"?, "icon"? } }`。`icon` は `/api/profile/icon?v=<mtime>` |
| `PUT /api/profile` | body `{ "name"?: "..." }` をいまの値に重ねる。空文字や `null` は「消す」。100文字まで（超えたら `400`）。別オリジンは `403` |
| `GET /api/profile/icon?v=<mtime>` | 自分のアイコン画像そのもの。無ければ `404`。キャッシュの扱いはセッションのアイコンと同じ |
| `PUT /api/profile/icon` / `DELETE /api/profile/icon` | 画像を置く / 消す（受け付ける種類・上限はセッションのアイコンと同じ）。`{ "profile": … }` を返す。別オリジンは `403` |
| `GET /api/settings` | サーバ側の設定。`{ "persona", "digest", "provider", "model", "linear_workspace" }`。`digest` は一言の配線が有効か（`SAI_DIGEST=1`）、`provider` はその口（`claude` / `openai`） |
| `PUT /api/settings` | body `{ "persona": "ENFP" }` / `{ "linear_workspace": "acme" }` をいまの値に重ねる（省略は据え置き）。`shared/persona.ts` に無い性格、`linear.app/<workspace>/` の形でない workspace は `400`（空文字は「設定なし」）。別オリジンは `403` |
| `GET /api/feed?days=3&project=` | 生の行と `replying`。アーカイブ済みセッションの行は除く |

返信の実行は `server/runner.ts`。`claude` / `codex` は `detached` で起動して待たず、stdout/stderr は `~/.agent-feed/reply.log` に追記する（うまく動かないときはここを見る）。同じエンティティに同時に2本は走らせない。

集計はサーバ側（`server/aggregate.ts`）。エンティティのキー（`<セッション>@<リポジトリ>`、セッションが取れない行は `unknown-<日付>`）は `shared/entity.ts` にあり、サーバの集計と画面のリンクが同じ関数を使う。ファイルは `(mtime, size)` で覚えていて、変わっていなければ再パースしない（`server/store.ts`）。1日開きっぱなしにしても重くならないのはこのため。

レスポンスの形は `shared/types.ts` に1つだけ書いてあり、サーバの集計と画面の受け取りが同じ型を見る。フィールドを足すときはそこに足すと、片方だけ忘れたときに `pnpm typecheck` で止まる。
