# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 何のリポジトリか

Claude Code / Codex CLI のターン完了をフックで `~/.agent-feed/YYYY-MM-DD.jsonl` に集め（**agent-feed** = `feed/`）、ローカルの画面で眺める（**SAI** = `server/` + `web/`）。詳細は README.md。コメント・コミットメッセージ・UI 文言は日本語で書く。

## コマンド

```
pnpm install
pnpm start                  # 127.0.0.1:8787。web/dist/ を配る（未ビルドなら案内ページ）
pnpm start -- --port 9000 --feed-dir ~/.agent-feed
pnpm dev                    # Vite。/api を 127.0.0.1:8787 に proxy するので pnpm start も並走させる
pnpm build                  # typecheck → vite build web（web/dist/ へ）
pnpm lint                   # oxlint web/src server shared
pnpm typecheck              # tsc -p web && tsc -p server
pnpm test                   # node:test（server/**/*.test.ts）
pnpm test:feed              # python3 -m unittest feed.test_record
```

コミット前の一式: `pnpm test && pnpm test:feed && pnpm lint && pnpm typecheck`

単体で回す:

```
node --test --disable-warning=ExperimentalWarning server/aggregate.test.ts
node --test --disable-warning=ExperimentalWarning --test-name-pattern="clip" server/aggregate.test.ts
python3 -m unittest feed.test_record.RecordTest.test_garbage_stdin_exits_zero_and_records_nothing
python3 -m unittest feed.test_record -k synth
```

### Node のバージョン

サーバとテストは Node の型剥がしで `.ts` を直接実行するため **Node 22.18+** が前提（`package.json` の `engines`）。このマシンの asdf 既定は 22.14.0 で、そのままだと `pnpm test` / `pnpm start` が `ERR_UNKNOWN_FILE_EXTENSION` で落ちる。asdf に 22.23.1 が入っているので `asdf shell nodejs 22.23.1` で切り替えるか、応急処置として `node --experimental-strip-types ...` を付ける。

`server/tsconfig.json` は `erasableSyntaxOnly: true`。サーバ側では enum / namespace / パラメータプロパティなど型剥がしで消せない構文は使えない。

## 構造

3つの部品が JSONL と `shared/types.ts` だけで繋がっている。

```
Claude Code (Stop hook) ─┐
                         ├─ feed/record.py ─append─> ~/.agent-feed/YYYY-MM-DD.jsonl
Codex CLI (notify) ──────┘                                   │
                                            server/store.ts が読む（(mtime,size) キャッシュ）
                                            server/aggregate.ts が行→セッションに集計
                                            server/app.ts が /api/* と web/dist/ を配る
                                                             │
                                            web/src が 3秒ポーリング（rev が同じなら再描画しない）
```

- **`shared/types.ts`** が唯一の型定義。`FeedRow`（JSONL 1行 = 1ターン）と API レスポンス型を、サーバ（集計側）と画面（受け取り側）が両方 import する。フィールドを足すときはここに足すと片方の漏れが `pnpm typecheck` で止まる。JSONL の形の正本は `feed/record.py` の `build_row()` なので、行にフィールドを足すときは record.py と types.ts の両方を触る。
- **`feed/record.py`** は Python 3.9+ 標準ライブラリのみ（エージェントの子プロセスとして PATH が最小の環境で呼ばれるので node に依存させない）。集計も表示もしない。
- **`server/`** は node:http 直書きで依存ゼロ。`main.ts` は引数処理と bind 先チェックだけで、ルーティングは `createApp(store, distDir)` にあり、テストはこれを直接叩く。`store.ts` は日付ファイルを `(mtime, size)` で覚えて変わらなければ再パースせず、そのシグネチャのハッシュを `rev` として返す。
- **`web/src/`** は React 19 + Vite、ルーティングは hash（`#/`、`#/s/<id>`、`#/feed`）。`hooks.ts` の `usePolling` がデータ取得の中心で、`rev` が変わらない限り state を触らず、タブが隠れている間は止まる。フィルタは `useLocalState` で localStorage に残る。

## 設計上の前提（変えるときは README も直す）

- **`record.py` は必ず exit 0。** フックが非0で終わるとエージェント本体を止めるため、失敗は黙って諦める（`AGENT_FEED_DEBUG=1` で `record-errors.log` に残す）。SIGALRM による15秒の自殺タイマーも入っている。stdin より先に argv を見るのも意図的（Codex 経路で閉じられない stdin を read してハングしない）。
- **セッション終了は掴めない**ので、両エージェントとも「ターン完了」を1行として記録し、セッションはサーバ側の `aggregate()` でまとめる。
- **Codex の notify にはセッションIDが無い**ので、`~/.codex/sessions/` の rollout ファイルを cwd で引く（`session_source: rollout`）。引けなければ `(repo, cwd, agent)` が同じで30分以内の前行と同じセッションにする（`synth`）。`session_index.jsonl` は壊れていることがあるので索引は使わない。
- **`first_user_text` は毎行に載せる。** 集計は最古の行の値を使うので、`days` の窓から1行目が落ちてもタイトルが残る。
- 日付の切り方は `Asia/Tokyo` 固定（`record.py` の `tz()` と `aggregate.ts` の `TIME_ZONE`）。
- **SAI は外に出さない。** `127.0.0.1` / `localhost` / `::1` 以外への bind は `main.ts` が拒否する。中身は作業内容そのものなので、デプロイ・ホスティング・Slack への送信はしない。
- 履歴（`*.jsonl`、`.agent-feed/`、`sessions/`）はコミットしない。`.gitignore` 済み。

## 環境変数

| | |
| --- | --- |
| `AGENT_FEED_DIR` | JSONL の置き場（既定 `~/.agent-feed`）。record.py とサーバの両方が見る |
| `AGENT_FEED_DEBUG` | `1` で record.py の例外をログに残す |
| `CODEX_HOME` | Codex のホーム（既定 `~/.codex`） |
| `SAI_PORT` | サーバの既定ポート（既定 `8787`） |
