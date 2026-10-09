# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 何のリポジトリか

Claude Code / Codex CLI / OpenCode のターン完了をフック（OpenCode はプラグイン）で `~/.agent-feed/YYYY-MM-DD.jsonl` に集め（**agent-feed** = `feed/`）、ローカルの画面で眺める（**SAI** = `server/` + `web/`）。詳細は README.md（何をするものか・セットアップ）と `docs/`。コメント・コミットメッセージ・UI 文言は日本語で書く。

## 文書の置き場（#444）

このファイルは毎ターン読まれるので、**知らずに触ると壊す決まりと、部品の地図だけ**を置く（目安 2 万字）。

| 書くこと | 置き場 |
| --- | --- |
| 横断の決まり・部品の地図の 1〜2 行 | この `CLAUDE.md` |
| 人に見える振る舞い・API・行の形 | `docs/screen.md` / `docs/api.md` / `docs/data.md` / `docs/tailnet.md` / `docs/local-llm.md` / `docs/design-notes.md` |
| 部品がどう動くか（ファイル・関数・定数） | `docs/internals/<部品>.md` |
| なぜそうなったか（前は…・実測…・レビューの指摘） | `docs/history/<部品>.md` の該当する節 |

**PR では仕様は `docs/`、経緯は `docs/history/` に書き、この `CLAUDE.md` を触るのは横断の決まりが変わったときだけ**（`/merge` の「書いた場所も見る」で確かめる）。ディレクトリごとの `CLAUDE.md` は作らない。

## コマンド

```
pnpm install
pnpm start                  # 127.0.0.1:8787。web/dist/ を配る（未ビルドなら案内ページ）
pnpm start --port 9000 --feed-dir ~/.agent-feed   # pnpm は「--」もそのまま渡すが、先頭の「--」は落とすので付けてもよい
pnpm start:watch            # server/ shared/ の変更で自動再起動（node --watch）
pnpm dev                    # Vite。/api をサーバに proxy するので pnpm start も並走させる（先は SAI_PORT。--port は見えない）
pnpm build                  # typecheck → vite build web（web/dist/ へ）
pnpm lint                   # oxlint web/src server shared
pnpm typecheck              # tsc -p web && tsc -p web/tsconfig.test.json && tsc -p server
pnpm test                   # node:test（server/、shared/、web/src/ の *.test.ts）
pnpm test:feed              # python3 -m unittest（feed/ のテスト）
```

コミット前の一式は **`bash scripts/suite.sh`**（`pnpm test` → `test:feed` → `lint` → `typecheck` を順に回す。`--build` で `build` も。通れば 1 行ずつ、落ちたら落ちた所だけ。#688）。大きな出力は以降の呼び出し全部に乗るので、**エージェントは素の `pnpm test` を回さず**、issue・PR の一覧にも本文を付けない → `AGENTS.md`。CI（`.github/workflows/ci.yml`）も同じ 4 つ＋ `pnpm build` を `main` への push と PR で回す（Node 22 系の最新、Python 3.9 と最新）。**スクリプトを足したら CI にも足す。**

単体で回す（ほかの形は `docs/internals/tooling.md`）:

```
node --test --disable-warning=ExperimentalWarning --test-name-pattern="clip" server/rows/aggregate.test.ts
```

このリポジトリだけに置くスキル（`~/.claude/skills/` には置かない。中身は `docs/internals/tooling.md`）:

- `/setup-sai` — clone 直後の配線と点検。**既存の設定を上書きしない**（1 つしか持てない `notify` / `statusLine` は読んで見せてから畳む）
- `/sync-main` — main worktree だけを最新の `main` に進めてビルドし、古いコードのサーバをそのペインで立て直す（起動コマンドに一言の設定は付けない）
- `/manager` — 他のセッションに送る文を提案する。**自分からは送らない**（人が「置いて」と言ったときだけ `sai_suggest` で宛先の入力欄に案を置く。`.claude/settings.json` の自動の許可には入れない）。読む口は `.mcp.json` の `sai-read`（SAI が渡す `sai` とは名前を分ける）。ツールの名前を変えたらスキルと `.mcp.json` も直す（`server/mcp/mcp.test.ts` が突き合わせる）
- `/merge` — レビューしてから squash マージするまでの手順（下の「PR とマージ」）

### PR とマージ

- **着手の前に、並行しているセッションと同じファイルを触っていないかを見る**（#564）。SAI から回っているターンなら `sai_sessions` の「同じファイル」で分かる。同じ関数・同じ箇所を変えていそうなら `sai_send` で 1 回だけ聞く（別の場所に足すだけなら聞かない）
- PR のベースは **必ず `main`**。積み重ねた PR は下が入ってからリベースしてベースを `main` に付け替える
- マージは **squash マージ**。`main` は PR 1 つ = コミット 1 つ
- **マージの前に、書いた本人とは別の目で 1 回レビューする**（#449）。自分で読み直すのは代わりにならない。レビューからマージ・後始末までの手順は `/merge` が正本で、飛ばさない

### Node と pnpm のバージョン

エラーの出方と理由は `docs/internals/tooling.md`。

- **Node 22.18+**（`package.json` の `engines`。サーバとテストは型剥がしで `.ts` を直接実行する）
- `server/tsconfig.json` は `erasableSyntaxOnly: true`。サーバ側では enum / namespace / パラメータプロパティなど型剥がしで消せない構文は使えない
- **pnpm 12 系**（CI も `version: 12`）。設定は `package.json` の `"pnpm"` ではなく **`pnpm-workspace.yaml`** で、`allowBuilds: { esbuild: true }` と `packages: [.]` は消さない
- `package.json` に `packageManager` は**書かない**

## 構造（部品の地図）

3 つの部品が JSONL と `shared/types.ts` だけで繋がっている。各部品の「どう動くか」は `docs/internals/<部品>.md`、「なぜそうなったか」は `docs/history/<部品>.md`。

```
Claude Code (Stop hook) ─────────┐
Codex CLI (notify) ──────────────┼─ feed/record.py ─append─> ~/.agent-feed/YYYY-MM-DD.jsonl
OpenCode (feed/opencode/sai.js) ─┘                           │
                                            server/rows/store.ts が読む（(mtime,size) キャッシュ）
                                            server/rows/aggregate.ts が行→セッションに集計
                                            server/app.ts が /api/* と web/dist/ を配る
                                                             │
                                            web/src が 3秒ポーリング（rev が同じなら再描画しない）
```

### 記録（feed/）

- **`feed/record.py`** は Python 3.9+ 標準ライブラリのみで必ず exit 0。待ちのフックでは stdout に何も出さない。`event` の読み方は `shared/events.ts` の `eventKind(event, text)` の 1 つだけ（`text` は省略不可、知らない `event` は `other`、`chatGroups.ts` は `other` を明示的に捨てる）。Claude の `text` は前のターンに遡らず、古い閉じた行を先に返さない。transcript を待つのは `Stop` のときだけ。本文の上限（20000 字）は外さない → docs/internals/feed.md#feedrecordpy
- **`feed/opencode/sai.js`** は opencode 本体の中で動くので throw しない。`record.py` の終了を待ち、状態は送る前に空にする。`permission.asked` / `replied` をプラグインで直列にしない（行が消える） → docs/internals/feed.md#feedopencodesaijsopencode-のプラグイン
- **Grok Build** は `detect_agent()` で `hookEventName` を Claude より先に見る（見ないと Claude として記録され、返信が `claude --resume` に向く）。返信は `replyBlockedReason()` が止める → docs/internals/feed.md#grok-buildxai-の-grok

### 集計と行の読み方

- 行 → セッションのまとめ方（`SessionEnd`、Codex のセッション ID の引き方、タイトル、`UserPromptSubmit`、`project`、「処理中」の置き場）→ docs/internals/aggregate.md

### サーバ（server/）

- **`server/`** は node:http 直書きで依存ゼロを保つ（検索も索引を持たない）。ルーティングは `createApp()` にあり、テストはこれを直接叩く。C-c / SIGTERM では必ず終わる（`shutdown()`）。SAI が起こした `opencode serve` は回していなければ落とし、回していれば次のサーバへ渡す。`codex app-server --stdio` は触らない → docs/internals/server.md#終わり方shutdown
- **`server/rows/store.ts`** の読む先は日付から組み立てず `readdir` + `feedFiles()` で拾う（`<host>` 付きも読む） → docs/internals/server.md#行の読み込みstorets
- **`server/rows/search.ts`** は `thinking` と待ちの行を見ず、アーカイブ済みも出す。判定と抜粋は `shared/search.ts` を画面と共用する → docs/internals/server.md#本文の検索rowssearchts
- **`server/local/usage.ts`** は API を叩かない（読むのはローカルのファイルだけ）。`UsageStore` のコンストラクタは置き場に既定値を持たせない。チップの出し方は `web/src/usageChips.ts` の 1 か所だけ → docs/internals/server.md#使用量localusagets
- **ビルド追従・`buildFreshness.ts`** は `X-SAI-Build` と `build_stale` で知らせる。git は叩かない → docs/internals/server.md#ビルドが古いことの判定localbuildfreshnessts
- **`server/local/claudeHooks.ts`** は `~/.claude/settings.json` を読むだけ。本物を読むのは `main.ts` だけで、`createApp` の既定は `NoClaudeHooks`。フックを足したら `shared/hooks.ts` の `EXPECTED_CLAUDE_HOOKS` と README の例の両方に足す。分からないときは出さない → docs/internals/server.md#フックの配線のずれlocalclaudehooksts
- **補った返答・`local/recovered.ts`**（#614）は JSONL に書かない。transcript を読むのは候補のときだけで、応答を待たせない。人に見せる・返答を引く道は `rowsNow()`、集計（`turns`）と一言は `store.rows()` のまま。前のターンの返答は出さない → docs/internals/progress.md#落ちた返答を-transcript-から補う614
- **Claude のログイン切れ・`local/claudeAuth.ts`**（#685）は `claude auth status --json` を読むだけ（`login` / `logout` / `setup-token` を起こさない）。ポーリングでは聞かない。本物を聞くのは `main.ts` だけ、分からないときは出さない、メール・組織は画面に渡さない → docs/internals/server.md#claude-のログイン切れlocalclaudeauthts685
- **SAI からのログイン・`local/claudeLogin.ts`**（#577）が起こすのは `claude auth login` の 1 形だけ（`logout` / `setup-token` は起こさない）。**切れていると分かっているときしか始めない**（いまのログインを差し替えない）。口は同一オリジンのみ。URL とコードは残さない（ログは数だけ）。子は 1 本・時間切れで落とす。子にだけ何もしない `open` を PATH の先頭に置く（Mac のブラウザを開かせない。PATH を差し替える例外はここだけ）。本物を組むのは `main.ts` だけ → docs/internals/server.md#sai-からログインし直すlocalclaudelogints577
- **`server/auth.ts`**（tailnet の認証）→ docs/internals/auth.md
- **返答に出てきたファイル・`local/files.ts`**（#603）はパスを受けず鍵で引く。cwd の中の文字のファイルだけで、`isSecretPath()` を外さない。**ループバックだけ**、HTML は描かない → docs/internals/server.md#返答に出てきたファイルを読むlocalfilests603
- **画像の軽い版・`local/thumbnails.ts`** は `sips` に**置き場に書き直したファイルだけ**を渡す（元のパス・リクエストの文字列は渡さない）。作れなければ 503。ライトボックスとダウンロードは元のまま → docs/internals/server.md#画像の軽い版localthumbnailsts

### 画面（web/src/）

- **部品の置き方**: `.tsx` は 1 ファイル = 1 コンポーネント・ファイル名 = コンポーネント名（`react/no-multi-comp`）。小さい部品も別ファイル、ロジックは `.ts` の純粋関数にして node:test。静的に並べた兄弟に同じ `key` を付けない（`siblingKeys.test.ts`。接頭辞で分ける）。effect の中で setState しない（描画中に導く）。hash は書き換えず `<a>` を `click()` → docs/internals/web.md#コンポーネントの置き方
- **要対応**: 待ちの定義は `shared/todoItems.ts` の `todoItems()`、数えるのは `pendingItems()` の 1 つだけ。画面・サイドバーのバッジ・題名と通知の 3 か所が同じ引数で呼ぶ。`done` は数えない。ターン完了かは `last_kind` で見て時刻で比べない。`useReply` は行でなく `TodoView` が持つ → docs/internals/web.md#要対応todoview224
- **サイドバー**: 画面の並びと `↑↓` は同じ `visibleIds()` から作る（`App` が組んで `SessionList` に渡す）。リポジトリの絞り込みは 2 つの `ProjectPicker` とも `filters.projects` の 1 つ → docs/internals/web.md#サイドバーの塊364
- **見出し**: 印は `headTags()` の 1 つ。`⋯` のパネルは `.chat-head` の中（外だと iOS で拡大）。Esc は capture で止める → docs/internals/web.md#チャット見出し274
- **入力欄**: `ReplyBox` は打ちかけを作ったとき 1 回だけ読むので `key={`reply:${id}`}` でセッションごとに作り直す。フィードには `draftKey` を渡さない。字送りに関わる CSS は textarea と `.ghost` の両方に当てる → docs/internals/web.md#入力欄replybox
- **チャット**: 発言は `ts` と側（`me` / `agent`）で名指しし、フィードの飛び先は `Utterance.key`。最下部追従は高さが変わったときだけ。返信の終わりは描いた行でなく `session.turns` で見る。検索の飛び先は 7 日の窓の外でも含める → docs/internals/web.md#セッション画面の-7-日の窓477
- **Markdown・画像**: HTML 文字列は作らない。外の URL の画像は読み込まない。画像のパスはリクエストから受けず鍵で引き、SVG は配らない（Codex の生成画像はそのスレッドの置き場の直下、`view_image` で見せた画像は realpath が行の `cwd` の中のものだけ）。表のセルに `overflow-wrap: anywhere` を継がせない。ライトボックスのキーは capture で止める → docs/internals/web.md#画像
- **型検査**: web の `tsconfig.json` はテストを除外し、`web/tsconfig.test.json` が `src/**/*.test.ts`、shared のテストは `server/tsconfig.json` が拾う → docs/internals/web.md#テストと型検査

### 返信

- **経路**: 可否は `replyBlockedReason()` の 1 つ（第 2 引数の host は省略不可）。子は `childEnv()` で `TMUX_PANE` を落とす（`TMUX` は残す）。SAI は行を起こさない → docs/internals/reply.md#経路
- **使用量**: 子の stdout は reply.log の fd のまま（pipe 不可）。`turn-usage.jsonl` は派生で記録は触らない。`rev` に `usage.rev()`。終わらない子は `settledByRow()` で終わりにして kill → docs/internals/reply.md#使用量
- **Codex**: writer lock はファイルでなく開いているプロセスで数え、`CodexApp.holds()` は queue に回さない → docs/internals/reply.md#codex
- **OpenCode**: 保留を見るためにサーバを起こさない。`directory` 必須。`always` を出さない。待ちは分からなければ残し時間で畳まない。規則は `shared/` と `sai.js` の二重で両テストの期待文字列を揃える。`share` / `shell`・`pty` / `--mdns`・`--cors` は開かない → docs/internals/reply.md#opencode
- **新しいセッション**: ID はサーバが決め cwd は `from` から。OpenCode は serve だけ（run に落とさない） → docs/internals/reply.md#新しいセッション
- **claude --bg**: 置き場は `--settings` の `env`、許可の配線なし。attach 中・ターン中は `claude stop` しない（`ps` が読めなければ居る扱い）。`run.start` に載せない → docs/internals/reply.md#claude---bg
- **預かり**: 前が `failed` なら回さない・追い越さない。steer は既定にしない、判定は `canSteer()` 1 つ → docs/internals/reply.md#預かりと-steer
- **Claude の `-p` を止める・足す**: 返信 1 回 = 1 プロセスのまま（長寿命にしない）。stdin だけ pipe、stdout はログの fd のまま。運用者が `--output-format` を指定したら口を開けない。止めた返信は失敗にせず使用量も残さない → docs/internals/reply.md#claude-の--p-を止める足す386
- **打ちかけ**: 端末の打ちかけは人の確認なしに消さない。失敗の戻しは入力欄が空のときだけ、非同期の失敗は押したときだけ → docs/internals/reply.md#打ちかけと失敗の戻し
- **画像・ファイル**: `ReplyRequest.attachments` の絶対パスを信じず `resolvePath()` を通す。種類は中身で決め、配る口（`find()`）は画像だけ。画像を受ける口（`-i` など）へ渡すのも画像だけ → docs/internals/reply.md#画像
- **許可モード**: 素通しでも SAI は許可を自動で返さない。`REPLY_MODES` 外は `400`。名前は英語 → docs/internals/reply.md#許可モード
- **モデル**: 名前（`Default` / `Custom model…`）は英語、保存値は正式名 → docs/internals/reply.md#モデル
- **別のマシン**: 判定は `isRemoteHost()` 1 つ、`host` が空はリモートにしない → docs/internals/reply.md#別のマシン
- **待ち**（#732）: 待てるのは PR の CI だけで、確かめるのはサーバの `gh`（決まった形。エージェントのターンは回さない）。1 つの待ちで起こすのは 1 回、起こす前に書く。断る線はループと同じ `loopRefusal()`。起きたターンから先へは送らせない・次を預けさせない → docs/internals/reply.md#待ち732
- **ループ**: 上限なしでは組めない。`sai_loop_next` から動かせるのは自分のループの「次」だけ。周は送る前に書く。起こすのは `launch()` のまま（権限のフラグを足さない・許可を自動で返さない）。素通し・端末・Claude 以外には組まない → docs/internals/reply.md#ループ634

### Codex の端末・app-server と処理中の手順

- **Codex の端末のダイアログ**: `CodexDialogs.answer()` は送る前・矢印のあと・`Enter` のあとの 3 回とも画面を読み直し、食い違えば `409` でキーは送らず押し直しもしない。`don't ask again` は範囲が全部読めたときだけ、範囲を書いたボタンにする（`dontAskScope()`。#741。`default.rules` は SAI が書かない・読まない）。中身が読めないダイアログは `answerable: false`。`approval_id` には中身を混ぜ、カーソルの位置は混ぜない → docs/internals/codex.md#ダイアログに画面から答える
- **ペイン → セッションの引き当て**: 分からなければ当てない。cwd の一番新しい rollout からは引かない。`lsof` が無ければ端末扱いにしない。tmux が落ちても前の結果は捨てず、失敗も覚える。前方一致は realpath でも比べ、返すパスは lsof のまま。行の無いセッションはダイアログの監視にだけ足す。`SAI_TERMINAL=0` では `scan()` を呼ばない → docs/internals/codex.md#ペインの側から探す
- **走査の締切**: `softWait()` を当てるのは画面に出す道だけ。返信の振り分けとレビューの断りは待ち切る → docs/internals/codex.md#走査の締切
- **app-server の許可・止める**: 画面に渡すのは不透明な id だけ。別の thread/turn・出していない decision・二重回答は断る。SAI 自身の「常に許可」（Claude の設定に書くルール）は出さない。Codex が候補に出してきた規則の追加は、範囲をボタンに書けるときだけ出す（`amendmentLabel()`。`default.rules` は読まない・書かない）。止めるのは SAI が回しているターンだけで、投げる前に預かりを `pause()` する。OpenCode の `abort` の返り値は当てにしない → docs/internals/codex.md#ターンを止める
- **処理中の手順**: `claude agents` には必ず `--json` を付ける。打ち消すのは busy が 1 つも無いと分かったときだけ、聞けなければ `undefined`。OpenCode は立っている serve にだけ聞く（段取りのために起こさない） → docs/internals/progress.md#claude-agents---json-で打ち消す

### 許可・Jev・セッション同士のメッセージ・MCP

- **返信中の許可・質問**: 答え（`POST /api/approvals/<id>/answer`）は同一オリジンのみ。預ける側は返信を処理中のエンティティだけ受ける。専用の要約が無いツールの JSON は `JSON.stringify` でなく `dumpsLikePython()`（`record.py` と同じ文字列。両方のテストに同じ期待文字列）。「常に許可」のルールはサーバが組み、画面は送らない → docs/internals/approvals.md#返信中の許可質問
- **効いている許可**: 読むだけ（書くのは「常に許可」の 2 経路だけ）。パスは cwd から固定で、リクエストから受けない → docs/internals/approvals.md#セッションに効いている許可
- **Jev**: 「SAI は外に出さない」の例外の 1 つ（もう 1 つは PR のレビューの投稿）。鍵が無ければ送らない・`settings.json` の `jev` で切れる・送り先固定でリダイレクトを追わない。環境から口を組むのは `main.ts` だけで `createApp` の既定は送らない。本文・cwd・Claude の要約は送らない。読む経路（`approvalsNow()`）から自動で答えない。自動の「常に許可」は Bash だけ、判定は `jevAutoDecision()` の 1 つ → docs/internals/approvals.md#jev
- **セッション同士のメッセージ**: `/api/agent/*` は `Origin` 付きを断り `agent-token` を要る。MCP にはトークンの場所だけ渡す。停止は同一オリジン。相手で回っているターンは止めない → docs/internals/agents.md#セッション同士のメッセージ
- **`/mcp`**: 許可は whois の capability だけで決める（Serve のヘッダは見ない）。ループバックと tailnet のユーザーの既定は `read` と `draft`（入力欄に案を置くだけ。ターンを起こさない）で、`send` は capability。`Origin` は必ず検査し `isCrossOrigin()` は使わない。素通しのセッションには送らない。ツール名を変えたらスキルと `.mcp.json` も直す → docs/internals/agents.md#tailnet-から-mcp-で呼ぶ口

### 差分・PR・メタ・未読・スキル

- **差分**: git は読むだけのサブコマンドだけ（`RealGit` の allowlist）。cwd・ブランチ・パスはリクエストから受けない → docs/internals/diff.md#差分ビューア
- **Codex のレビュー**: 同一オリジンのみ。預かりに回さない。ほかで開いているスレッドは返信と同じ `codexHeldElsewhere()` で断る → docs/internals/diff.md#codex-にレビューさせる
- **差分・PR の行コメント**: 画面から直接送らず、返信欄（打ちかけ）に足すだけ → docs/internals/diff.md#差分の行へのコメント
- **PR と gh**: 外に出る数少ない口。認証は `gh` 任せ、組み立てる形は決め打ち。並べるのは記録で知っている repo だけ（任意の名前を `gh` に渡さない）。失敗しても差分は落とさない → docs/internals/diff.md#github-の-pr-を読む
- **レビューの投稿**: GitHub に書く唯一の口。同一オリジンのみ。head が違えば 409、行はいまの差分で探し直し中身が同じときだけ送る → docs/internals/diff.md#github-にレビューを投稿する
- **メタ**: PUT の意味は `mergeMeta()` が正本。表示名が無ければ `-n` を渡さない → docs/internals/meta.md#セッションのメタ
- **アイコン**: パスは ID から組み立てない。履歴の鍵は `^[0-9a-f]{16}$` だけ、パスは受けずサーバの置き場から読む。自分のアイコンは鍵 `me` → docs/internals/meta.md#アイコンの履歴
- **未読**: PUT は同一オリジンのみ。既読は前にしか進めない。数えるのはターン完了だけ → docs/internals/meta.md#未読の印
- **スキル**: Codex は `$name`、他は `/name`。OpenCode は `directory` を渡し、候補のためにサーバを起こさない → docs/internals/meta.md#-のスキルの候補

### 一言（digest）

- **一言（digest）**は `server/digest/digest.ts`（仕組み → docs/internals/digest.md、経緯 → docs/history/digest.md）。
  - 送り先 `SAI_DIGEST_URL` と鍵は環境変数だけ。`settings.json` にも PUT にも入れない。モデル名は `isDigestModel()` を通す（`-` 始まりは不可）。
  - セッションで切るのは `digest_off`（`true` があることが状態）。`persona: 'off'` は作らない。
  - 一言の `claude -p` には `AGENT_FEED_SKIP=1` を渡す。道具・MCP・スキル・思考は外して起こす（#740。**足すのは減らす側だけ**で権限のフラグは足さない。利用者の設定ファイルは読むまま）。
  - プロンプトと作例に具体的な番号・中身の語を置かない（`persona.test.ts` が止める）。
  - `digestIssues()` は LLM を呼ばない純粋関数。`user_text` は番号の裏付けにだけ使い、依頼・題名の判定に混ぜない。
  - 「変？」の POST は同一オリジンのみで、溜めたものは外に出さない。一言・口・性格は鍵から引く。
  - 次に送る文面の案（`next_ask`）に性格を足さない。フィードには渡さない。`settings.json` の `next_ask` は読むときに埋めない。
  - 偽の `Summarizer` は一言と案のプロンプトを別に数える。
  - プロンプトを変える前に `pnpm digest:eval` で今の案と比べる（#712。手元で回す）。**事例（`server/tools/digest-eval/cases.json`）は作り物だけ**で、実際の返答・名前の類をコミットしない。出力はリポジトリの外、貼るのは件数と割合だけ。
  → docs/internals/digest.md#出来上がりの確かめdigestissues-の各項目


## 横断の決まり（変えるときは README / docs も直す）

- **`record.py` は必ず exit 0。** フックが非 0 で終わるとエージェント本体を止める。失敗は黙って諦める（`AGENT_FEED_DEBUG=1` で `record-errors.log`）。15 秒の自殺タイマー（SIGALRM）と、stdin より先に argv を見る（Codex 経路で閉じない stdin を read してハングしない）のも意図的
- **行にフィールドを足すときは `feed/record.py` の `build_row()`（正本）と `shared/types.ts` の両方を触り、`RECORD_VERSION` を両方で上げる**（ずれると `pnpm test:feed` が止まる）。行の形を変えない変更では上げない
- **`shared/types.ts` が唯一の型定義**（サーバと画面が両方 import する。足し漏れは `pnpm typecheck` で止まる）
- **エンティティの単位は (セッション, リポジトリ)。** ID は `<セッション>@<リポジトリ>`（取れない行は `unknown-<日付>`）。**必ず `shared/entity.ts` の `entityId()` を通す**（集計・詳細 API・画面のリンクが別々に組み立てるとリンク切れになる）
- **一覧の絞り込みは `project`（どのリポジトリか）で、`repo`（worktree 名になる）ではない。** `rowProject()` は `repo` に落とさない。**`repo` の値は変えない**（エンティティ ID が変わると `session-meta.json` のキー・アイコン・アーカイブ・URL がずれる）
- **セッションの 1 つだけ出す値は `latestValue()`（値のある一番新しい行）で取る。** `orderedUnique(...)` の最後は使わない。`session_source` は `synth` が 1 本でもあれば `synth`
- `turns` と「返信が終わった」は `Stop`（`eventKind() === 'turn'`）の行だけで数える。`first_user_text` は毎行に載せる
- 日付の切り方は `Asia/Tokyo` 固定（`record.py` の `tz()` と `shared/entity.ts` の `TIME_ZONE`）
- **SAI は外に出さない。** `127.0.0.1` / `localhost` / `::1` 以外への bind は `main.ts` が拒否する。デプロイ・ホスティング・Slack への送信はしない。出してよいのは tailnet までで `tailscale serve` 経由だけ（bind は変えない、funnel は使わない）。**例外は 2 つだけ**: `JEV_API_KEY` を置いたときの許可の予想（#491。`settings.json` の `jev` で切れる）と、人が確認の画面で押したときの PR のレビューの投稿（#526）。外に問い合わせる `gh` は `server/git/` の決まった形だけ
- **Serve 越しの認証は whois で突き合わせる**（`server/auth.ts`）。ヘッダがどちらも無いものだけがループバック。タグ付きの端末は画面・REST は 401 で、capability を与えた `/mcp` だけ。「聞けなかった」と「居ない」を混ぜない → `docs/internals/auth.md`
- **ブラウザから叩く書き込みの口は同一オリジンのみ**（`app.ts` の `isCrossOrigin()` を外さない）: 返信・新しいセッション・承認の答え・レビュー・一言の「変？」・既読・送信の停止など。**`cwd`・パス・ブランチはリクエストから受けず、セッションの行から取る**（新しいセッションも `from` の `cwd`）
- **SAI 自身は起動するコマンドに権限のフラグを付けない。** 運用者が `SAI_CLAUDE_ARGS` / `SAI_CODEX_ARGS` で渡すのは可（`docs/screen.md` の「返信と許可」の範囲。バイパスは勧めない）
- **「処理中の返信」はメモリと `~/.agent-feed/replying.json` の両方**（再起動で忘れると返信が二重に走る）。失敗は `Replying.failed` で画面に出す
- **セッションの呼び名（SAI の表示名）・実際の worktree 名・ほかのリポジトリの名前は、コミットするファイル・コミットメッセージ・issue・PR に書かない。** 「セッション A」「`dev-worktree-a`」「リポジトリ A」のように書く（テストの作り物の名前も同じ）。詳しくは `AGENTS.md`
- **SAI に画像を出すには返答の本文に `![名前](パス)` と書く。** 置き場は `.screenshots/`（`.gitignore` 済み）。`/tmp` と `web/dist/` は使わない（#704。`AGENTS.md` と同じ文）
- 履歴（`*.jsonl`、`.agent-feed/`、`sessions/`）はコミットしない（`.gitignore` 済み）。テストやスクラッチのサーバで本物の `~/.agent-feed` を触らない（`AGENT_FEED_DIR` を一時ディレクトリに）

## 環境変数

**表は README の「環境変数」だけに置く**（#675。どれも省略でき、既定値で動く）。読み方の細部は `docs/internals/tooling.md#環境変数の表`。

- **変数を足したら README の表に足す。** 表は「設定することがあるもの」と「切り分け・内部」の 2 つに分け、同じ変数を 2 回載せない（#288）。コードが読む変数と表が揃っているかは `server/docs.test.ts` が見る
- 利用者が設定しないもの（SAI が自分で付ける・エージェントが渡してくる）は表に載せず、`server/docs.test.ts` の `INTERNAL` と README の表の下の一文に足す
- **実行ファイル（`claude` / `codex` / `opencode` / `tmux` / `git` / `gh` / `tailscale` / `sips`）はサーバの `PATH` から探す。** 差し替えの変数（`SAI_*_BIN`）は作らず、テストは偽物を引数で渡す
- **記録側とサーバは同じ変数を見る**（`AGENT_FEED_DIR` / `AGENT_FEED_HOST`。片方だけ別の名前にすると自分のセッションが「別のマシン」になる）
- 一言の送り先（`SAI_DIGEST_URL`）と鍵は環境変数だけ。Jev の鍵（`JEV_API_KEY`）を読むのは `server/main.ts` の `jevFromEnv()` だけ
