# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 何のリポジトリか

Claude Code / Codex CLI のターン完了をフックで `~/.agent-feed/YYYY-MM-DD.jsonl` に集め（**agent-feed** = `feed/`）、ローカルの画面で眺める（**SAI** = `server/` + `web/`）。詳細は README.md。コメント・コミットメッセージ・UI 文言は日本語で書く。

## コマンド

```
pnpm install
pnpm start                  # 127.0.0.1:8787。web/dist/ を配る（未ビルドなら案内ページ）
pnpm start --port 9000 --feed-dir ~/.agent-feed   # pnpm 10 は「--」もそのまま渡すが、先頭の「--」は落とすので付けてもよい
pnpm start:watch            # server/ shared/ の変更で自動再起動（node --watch）
pnpm dev                    # Vite。/api を 127.0.0.1:8787 に proxy するので pnpm start も並走させる
pnpm build                  # typecheck → vite build web（web/dist/ へ）
pnpm lint                   # oxlint web/src server shared
pnpm typecheck              # tsc -p web && tsc -p server
pnpm test                   # node:test（server/**/*.test.ts と shared/**/*.test.ts）
pnpm test:feed              # python3 -m unittest feed.test_record
```

コミット前の一式: `pnpm test && pnpm test:feed && pnpm lint && pnpm typecheck`

CI（`.github/workflows/ci.yml`）も同じ一式＋ `pnpm build` を `main` への push と PR で回す。Node 22 系の最新、Python 3.9 と最新。スクリプトを足したら CI にも足す。

単体で回す:

```
node --test --disable-warning=ExperimentalWarning server/aggregate.test.ts
node --test --disable-warning=ExperimentalWarning --test-name-pattern="clip" server/aggregate.test.ts
python3 -m unittest feed.test_record.RecordTest.test_garbage_stdin_exits_zero_and_records_nothing
python3 -m unittest feed.test_record -k synth
```

### PR とマージ

- PR のベースは **必ず `main`**。積み重ねた PR は下が入ってからリベースしてベースを `main` に付け替える（#6 はベースがマージ済みの作業ブランチのままマージされ、`main` に入らなかった）
- マージは **squash マージ**（`gh pr merge <番号> --squash`）。`main` は PR 1つ = コミット1つにする
- `gh pr edit --base` が GraphQL の非推奨エラーで失敗することがある。そのときは `gh api -X PATCH repos/<owner>/<repo>/pulls/<番号> -f base=main` を使う

### Node のバージョン

サーバとテストは Node の型剥がしで `.ts` を直接実行するため **Node 22.18+** が前提（`package.json` の `engines`）。古い Node だと `pnpm test` / `pnpm start` が `ERR_UNKNOWN_FILE_EXTENSION` で落ちる。バージョンを上げるのが本筋で、応急処置なら `node --experimental-strip-types ...` を付ける。

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
- **`feed/record.py`** は Python 3.9+ 標準ライブラリのみ（エージェントの子プロセスとして PATH が最小の環境で呼ばれるので node に依存させない）。集計も表示もしない。Claude のフック名がそのまま `event` に載り、`Stop` 以外に「人を待って止まった」行（`PermissionRequest` / `PreToolUse` / `Notification`。`text` は `許可待ち: Bash: …` のような要約）と「再開した」行（`UserPromptSubmit`。直前が待ちのときだけ）も書く。待ちのフックでは **stdout に何も出さない**（`decision` を出すと許可の判断に触る）。`event` の読み方（turn / waiting / resume）は `shared/events.ts` の `eventKind()` に1つだけあり、`aggregate.ts` の `turns` / `waiting` / `last_text` と画面の待ちバブル（`chatGroups.ts`）が同じ判定を使う。
- **`server/`** は node:http 直書きで依存ゼロ。`main.ts` は引数処理と bind 先チェックだけで、ルーティングは `createApp(store, distDir)` にあり、テストはこれを直接叩く。`store.ts` は日付ファイルを `(mtime, size)` で覚えて変わらなければ再パースせず、そのシグネチャのハッシュを `rev` として返す。
- **`web/src/`** は React 19 + Vite。1画面で、左サイドバー（`SessionList`）に一覧、右ペインにチャット（`FeedView` / `SessionView`）。ルーティングは hash（`#/` と `#/feed` がフィード、`#/s/<id>` がセッション。広い画面では `#/` と `#/feed` は同じ表示で、狭い画面だけ `#/` が一覧のみになる。切り替えは CSS の `main.route-*`）。絞り込みの state は `App.tsx` が持ち、サイドバーとフィードの両方に渡す。`hooks.ts` の `usePolling` がデータ取得の中心で、`rev` が変わらない限り state を触らず、タブが隠れている間は止まる。フィルタは `useLocalState` で localStorage に残る。**`.tsx` は 1 ファイル = 1 コンポーネント、ファイル名 = コンポーネント名**（oxlint の `react/no-multi-comp` が `pnpm lint` で止める）。小さい部品（`More`、`SynthTag`、`MenuMark` など）も自分のファイルに置く。コンポーネントでないロジックは `.ts` に出す（例: `chatGroups.ts` の `groupRows()` はチャットの行をバブルの塊にまとめる純粋関数で、`chatGroups.test.ts` を node:test で回す。キーボードでのセッション移動も `sessionNav.ts` の純粋関数（`navAction` / `neighborSessionId`）を `App.tsx` の keydown が呼ぶ形で、`sessionNav.test.ts` で回す）。
- **チャットの本文は Markdown**。`shared/markdown.ts` が `text` を木（`Block` / `Inline`）にし、`web/src/Markdown.tsx` が React 要素に組み立てる（HTML 文字列は作らない）。パーサは DOM 非依存なので `shared/markdown.test.ts` を node:test で回す。web の `tsconfig` は `../shared/**/*.test.ts` と `src/**/*.test.ts` を除外している（`node:test` の型が無いため）。一覧の `last_text` は同じファイルの `stripMarkdown()` で記号を落とす。
- **返信**（`POST /api/sessions/<id>/reply`）は `server/runner.ts` が `claude -p --resume` / `codex exec resume` を `cwd` で detached 起動する。結果は既存のフックが JSONL に足す1行として届くので、返信専用の記録経路は無い。返信できるかの判定は `shared/reply.ts` の `replyBlockedReason()` にあり、サーバの受付と画面の入力欄の出し分けが同じ関数を使う。画面側の送信と「送信中」の判定は `web/src/useReply.ts`（返信先ごとの行数が送信時より増えたら消える）で、セッション画面とフィードが共用する。フィードの返信先は `@` メンションで選ぶ。候補の組み立て（`sessionReplyTargets` がサイドバーの一覧から、`feedReplyTargets` がフィードの行から作り、`mergeReplyTargets` で一覧を先に並べる。一覧のポーリングは `App.tsx` が1回だけ行い、`SessionList` と `FeedView` の両方に渡す）、`@` の検出（`mentionQuery`）、本文に入れる表記（`mentionLabels` / `stripMention`）は `shared/reply.ts` にあり `shared/reply.test.ts` で回す。テストは `createApp(store, distDir, runner)` に `FakeRunner` を渡して実際には起動しない。
- **返信中の許可・質問**（`POST /api/approvals`）: 返信の `claude` に `--mcp-config` で SAI の MCP サーバ（`server/approve-mcp.ts`。stdio、依存ゼロ、`initialize` / `tools/list` / `tools/call` だけ）を足し、`--permission-prompt-tool mcp__sai__approve` で許可が要るたびに呼ばれる。ツールは `POST /api/approvals` で預けて `GET /api/approvals/<id>?wait=1` で待ち、画面の `POST /api/approvals/<id>/answer` の決定をそのまま CLI に返す。預かりは `server/approvals.ts`（メモリ。プロセスが exit したら `drop`、90 秒取りに来なければ捨てる）。文言（`許可待ち: Bash: …`）は `shared/approvals.ts` で、`record.py` の待ちの行と揃える。`rev` に答え待ちの集合を混ぜるので画面のポーリングが拾う。Claude だけ（Codex に口が無い）。テストは `server/approve-mcp.test.ts` が実際に子プロセスを立てる。 「常に許可」は画面が `remember: 'local'` を送り、サーバが `shared/approvals.ts` の `alwaysAllowRule()` でルール（`Bash(gh pr:*)` など）を組み立てて `updatedPermissions`（`destination: localSettings`）として CLI に返す。CLI が cwd の `.claude/settings.local.json` に書く。画面はルールを送らない。
- **表示名・アーカイブ**（`GET/PUT /api/sessions/<id>/meta`）は `server/meta.ts` の `MetaStore` が `~/.agent-feed/session-meta.json` に持つ（JSONL は触らない）。`createApp` が応答を返すときに `SessionSummary.meta` として載せ、rev にもファイルの状態を混ぜる。**アイコン画像**（`GET/PUT/DELETE /api/sessions/<id>/icon`）は `server/icons.ts` の `IconStore` が `~/.agent-feed/session-icons/<sha1(ID) の先頭16桁>.<ext>` にファイルで持ち（`session-meta.json` には書かない。ID からパスを組み立てない）、`SessionSummary.icon` に `?v=<mtime>` 付きの URL として載せる。受け付ける種類・上限・中身の判定（`sniffImageType`）は `shared/icon.ts` にあり、サーバの受付と画面の「画像を選ぶ」（`MetaEditor`）が同じ値を見る。絵文字のアイコンは廃止済みで、古い `icon` キーは `mergeMeta()` が知らないキーとして捨てる。PUT は**重ねる**（省略は据え置き、空や null は消す）意味で、`shared/meta.ts` の `mergeMeta()` がその正本。画面の入力欄（`web/src/MetaEditor.tsx`）は同じファイルの `normalizeMeta()` で検査する。アーカイブは `archived_at` を載せるだけで、「アーカイブ済みか」は `createApp` が `archived_at >= end` で決めて `SessionSummary.archived` に出す（行が増えれば自動で戻る）。`/api/sessions` は既定でアーカイブ済みを除き（`archived=1` で逆）、`/api/feed` もその行を除く。画面の切り替えは `web/src/useArchive.ts` で、チャット見出し（`ArchiveButton`）とサイドバーの項目（`SessionArchiveButton`）が共用する。
- **自分の表示名とアイコン**（`GET/PUT /api/profile`、`GET/PUT/DELETE /api/profile/icon`）は `server/profile.ts` の `ProfileStore` が `~/.agent-feed/profile.json` に名前を持ち、アイコンは同じ `IconStore` に固定の鍵（`shared/profile.ts` の `PROFILE_ICON_ID` = `me`）で置く。応答の `profile` に載せ、`rev` にも混ぜる。画面はヘッダー右端の `UserMenu` → `ProfileEditor`（モーダル）で編集し、`chatGroups.ts` の `speakerLabel()` が自分側のバブルの名前とアバターに当てる（無ければ「あなた」/「私」）。
- **別ターミナルの `pnpm build` に追従する。** サーバは `web/dist/` を毎回ディスクから読み、`/api/*` に `X-SAI-Build`（`dist/index.html` の mtime）を付ける。`web/src/api.ts` の `watchBuild` がポーリングのついでにそれを見て、変わっていたら `location.reload()` する（`pnpm dev` 中は HMR に任せて何もしない）。サーバ側の再起動は `pnpm start:watch`。
- **ビルドが古いことはサーバが判定して画面に出す。** `server/buildFreshness.ts` が `web/dist/index.html` と `web/src` / `web/index.html` / `shared`（`*.test.ts` を除く）の mtime を 30 秒に1回比べ、`/api/sessions` と `/api/feed` の `build_stale` に載せる（`rev` にも混ぜる）。`App.tsx` はそれでヘッダの下にバナーを出す（`pnpm dev` では出さない）。git は叩かない。

## 設計上の前提（変えるときは README も直す）

- **`record.py` は必ず exit 0。** フックが非0で終わるとエージェント本体を止めるため、失敗は黙って諦める（`AGENT_FEED_DEBUG=1` で `record-errors.log` に残す）。SIGALRM による15秒の自殺タイマーも入っている。stdin より先に argv を見るのも意図的（Codex 経路で閉じられない stdin を read してハングしない）。
- **セッション終了は掴めない**ので、両エージェントとも「ターン完了」を1行として記録し、セッションはサーバ側の `aggregate()` でまとめる。
- **Codex の notify にはセッションIDが無い**ので、`~/.codex/sessions/` の rollout ファイルを cwd で引く（`session_source: rollout`）。引けなければ `(repo, cwd, agent)` が同じで30分以内の前行と同じセッションにする（`synth`）。`session_index.jsonl` は壊れていることがあるので索引は使わない。
- **セッションのタイトルは一番新しい `user_text` に追従する。** `aggregate.ts` の `sessionTitle()` が新しい行から遡って最初の `user_text` の1行目を使うので、画面から返信しても端末で続きの指示を打っても、次のターンが記録された時点で説明文が変わる。フィードの `@` メンション候補のラベル（`feedReplyTargets`）も同じ順。`user_text` が1行も無いときだけ `first_user_text` に落ちる。
- **`first_user_text` は毎行に載せる。** フォールバック時の集計は最古の行の値を使うので、`days` の窓から1行目が落ちてもタイトルが残る。
- **自分の入力は `UserPromptSubmit` の行で先に届く。** `record.py` は Claude の入力のたびに `user_text` だけの行（`event: UserPromptSubmit`、`text` は空）を書き、続く `Stop` の行にも同じ `user_text` が載る。Claude Code が差し込む入力（バックグラウンドのタスク完了の `<task-notification>`。transcript では `promptSource: system`）は人の入力ではないので `user_text` にしない（`record.py` の `_is_system_prompt()`）。画面（`web/src/chatGroups.ts`）は同じエンティティで直前の入力行と同じ文なら `Stop` 側の自分バブルを出さない。`turns` と「返信が終わった」の判定は `Stop` の行だけで数える（`eventKind() === 'turn'`）。画面から返信したときの仮バブルは、入力の行が届いたら `promptArrived()` で本文を消して「処理中」の1行にする。
- **エンティティの単位は (セッション, リポジトリ)。** IDは `<セッション>@<リポジトリ>`（セッションが取れない行は `unknown-<日付>`）。キーの作り方は `shared/entity.ts` の `entityId()` にあり、サーバの集計（`aggregate.ts`）・詳細APIの行の絞り込み（`app.ts`）・画面のリンク（`Chat.tsx`）が全部これを使う。別々に組み立てるとリンク切れになるので必ず共有関数を通す。
- 日付の切り方は `Asia/Tokyo` 固定（`record.py` の `tz()` と `shared/entity.ts` の `TIME_ZONE`）。
- **SAI は外に出さない。** `127.0.0.1` / `localhost` / `::1` 以外への bind は `main.ts` が拒否する。中身は作業内容そのものなので、デプロイ・ホスティング・Slack への送信はしない。
- **返信の POST は同一オリジンのみ。** ブラウザから任意の `cwd` でコマンドが走るので、`app.ts` の `isCrossOrigin()`（`Origin` / `Sec-Fetch-Site`）は外さない。SAI 自身は起動するコマンドに権限のフラグを付けない（非対話なので許可ダイアログは出せず、未許可のツールは拒否される）。運用者が `SAI_CLAUDE_ARGS` / `SAI_CODEX_ARGS` で明示的に渡すのは可で、それは README の「返信と許可」に書いてある範囲（ツール単位の `--allowedTools` を勧め、バイパスは CSRF の観点から勧めない）。
- **承認の答え（`POST /api/approvals/<id>/answer`）も同一オリジンのみ。** ここが通ると別サイトから「許可」が押せる。`POST /api/approvals`（預ける側）は返信を処理中のエンティティの分しか受けない。
- 履歴（`*.jsonl`、`.agent-feed/`、`sessions/`）はコミットしない。`.gitignore` 済み。

## 環境変数

| | |
| --- | --- |
| `SAI_HOME` | このリポジトリの場所。README のフック設定例（`settings.json` の `env`）が使うだけで、コードは読まない |
| `AGENT_FEED_DIR` | JSONL の置き場（既定 `~/.agent-feed`）。record.py とサーバの両方が見る |
| `AGENT_FEED_DEBUG` | `1` で record.py の例外をログに残す |
| `CODEX_HOME` | Codex のホーム（既定 `~/.codex`） |
| `SAI_PORT` | サーバの既定ポート（既定 `8787`） |
| `SAI_CLAUDE_BIN` / `SAI_CODEX_BIN` | 返信で起動する CLI の実行ファイル（既定は PATH の `claude` / `codex`） |
| `SAI_CLAUDE_ARGS` / `SAI_CODEX_ARGS` | 返信のコマンドに足す引数（`--allowedTools "Bash(gh *)"` など。シェル風に割る。`server/runner.ts` の `splitArgs()`）。Claude は先頭に置く（`--allowedTools` は可変長で、後ろだと本文を飲む） |
| `SAI_APPROVE` | `0` で返信中の許可・質問を画面で答える配線（`--mcp-config` + `--permission-prompt-tool`）を付けない |
