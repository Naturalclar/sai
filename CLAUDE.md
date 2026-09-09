# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 何のリポジトリか

Claude Code / Codex CLI のターン完了をフックで `~/.agent-feed/YYYY-MM-DD.jsonl` に集め（**agent-feed** = `feed/`）、ローカルの画面で眺める（**SAI** = `server/` + `web/`）。詳細は README.md（何をするものか・セットアップ）と `docs/`（画面・API・データの形・先に確かめた前提）。コメント・コミットメッセージ・UI 文言は日本語で書く。

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
pnpm test:feed              # python3 -m unittest feed.test_record
```

コミット前の一式: `pnpm test && pnpm test:feed && pnpm lint && pnpm typecheck`

main worktree を最新の `main` に進めてビルドし直すのは `/sync-main`（`.claude/skills/sync-main/SKILL.md`。別の worktree から呼んでも main worktree だけを触る。古いコードで動いているサーバは、そのペインで `SAI_DIGEST=1 SAI_DIGEST_PROVIDER=openai SAI_DIGEST_MODEL=qwen3:8b pnpm start` に立て直す）。

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

### pnpm のバージョン

**pnpm 12 系**が前提（CI の `pnpm/action-setup` も `version: 12`）。設定は `package.json` の `"pnpm"` フィールドではなく **`pnpm-workspace.yaml`** に置く（12 系は前者を読まず、WARN を出して無視する）。

- `allowBuilds: { esbuild: true }` — インストール時のビルドスクリプトの許可。無いと `ERR_PNPM_IGNORED_BUILDS` で `pnpm install` が落ち、通しても esbuild のバイナリが無く `pnpm build` が失敗する。
- `packages: [.]` — 単一パッケージでも必須。無いと `pnpm build` の中の入れ子の `pnpm typecheck` が `packages field missing or empty` で落ちる。

`package.json` に `packageManager` は**書かない**。pnpm 12 のバイナリは corepack のキャッシュに `bin/pnpm.cjs` を持たないため、入れ子の `pnpm` 呼び出しが `Cannot find module .../pnpm.cjs` で落ちる。

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

- **`shared/types.ts`** が唯一の型定義。`FeedRow`（JSONL 1行 = 1ターン）と API レスポンス型を、サーバ（集計側）と画面（受け取り側）が両方 import する。フィールドを足すときはここに足すと片方の漏れが `pnpm typecheck` で止まる。JSONL の形の正本は `feed/record.py` の `build_row()` なので、行にフィールドを足すときは record.py と types.ts の両方を触り、**`RECORD_VERSION` を両方で上げる**（行の `v`。ずれると `pnpm test:feed` が止まる。画面は一番新しい行の `v` が古いと「record.py が古い」と出す）。
- **`feed/record.py`** は Python 3.9+ 標準ライブラリのみ（エージェントの子プロセスとして PATH が最小の環境で呼ばれるので node に依存させない）。集計も表示もしない。Claude のフック名がそのまま `event` に載り、`Stop` 以外に「人を待って止まった」行（`PermissionRequest` / `PreToolUse` / `Notification`。`text` は `許可待ち: Bash: …` のような要約）と「再開した」行（`UserPromptSubmit`。直前が待ちのときだけ）も書く。待ちのフックでは **stdout に何も出さない**（`decision` を出すと許可の判断に触る）。`event` の読み方（turn / waiting / resume）は `shared/events.ts` の `eventKind()` に1つだけあり、`aggregate.ts` の `turns` / `waiting` / `last_text` と画面の待ちバブル（`chatGroups.ts`）が同じ判定を使う。
- **`server/`** は node:http 直書きで依存ゼロ。`main.ts` は引数処理と bind 先チェックだけで、ルーティングは `createApp(store, distDir)` にあり、テストはこれを直接叩く。`store.ts` は日付ファイルを `(mtime, size)` で覚えて変わらなければ再パースせず、そのシグネチャのハッシュを `rev` として返す。
- **`web/src/`** は React 19 + Vite。1画面で、左サイドバー（`SessionList`）に一覧、右ペインにチャット（`FeedView` / `SessionView`）。ルーティングは hash（`#/` と `#/feed` がフィード、`#/s/<id>` がセッション。広い画面では `#/` と `#/feed` は同じ表示で、狭い画面だけ `#/` が一覧のみになる。切り替えは CSS の `main.route-*`）。絞り込みの state は `App.tsx` が持ち、サイドバーとフィードの両方に渡す。`hooks.ts` の `usePolling` がデータ取得の中心で、`rev` が変わらない限り state を触らず、タブが隠れている間は止まる。フィルタは `useLocalState` で localStorage に残る。**`.tsx` は 1 ファイル = 1 コンポーネント、ファイル名 = コンポーネント名**（oxlint の `react/no-multi-comp` が `pnpm lint` で止める）。小さい部品（`More`、`SynthTag`、`MenuMark` など）も自分のファイルに置く。コンポーネントでないロジックは `.ts` に出す（例: `chatGroups.ts` の `groupRows()` はチャットの行をバブルの塊にまとめる純粋関数で、`chatGroups.test.ts` を node:test で回す。キーボードでのセッション移動も `sessionNav.ts` の純粋関数（`navAction` / `neighborSessionId`）を `App.tsx` の keydown が呼ぶ形で、`sessionNav.test.ts` で回す）。
- **チャットの本文は Markdown**。`shared/markdown.ts` が `text` を木（`Block` / `Inline`）にし、`web/src/Markdown.tsx` が React 要素に組み立てる（HTML 文字列は作らない）。`:tada:` の絵文字も同じ行内解析で、名前 → 絵文字の表と `:` の検出・絞り込みは `shared/emoji.ts`（`lookupEmoji` / `emojiQuery` / `filterEmoji`）にある。表に載っている名前だけを `emoji` ノードにするので、`14:08:30` のような時刻は文字のまま。パーサは DOM 非依存なので `shared/markdown.test.ts` と `shared/emoji.test.ts` を node:test で回す。web の `tsconfig.json` は `../shared/**/*.test.ts` と `src/**/*.test.ts` を除外している（画面のビルドに `node:test` の型を混ぜないため）。web 側のテストの型検査は `web/tsconfig.test.json`（`types: ["node", "vite/client"]`、`src/**/*.test.ts` だけ）が持ち、`pnpm typecheck` の 2 つ目で回る。shared 側のテストは `server/tsconfig.json` が `../shared` ごと拾う。一覧の `last_text` は同じファイルの `stripMarkdown()` で記号を落とす。
- **返信**（`POST /api/sessions/<id>/reply`）は、セッションが tmux のペインで開いていれば（行の `pane` / `pid`、pid が生きている）`server/terminal.ts` がそのペインに打ち込む（`load-buffer` → `paste-buffer -p` → `send-keys Enter`。入力中・ダイアログ中なら 409、ペインが消えていれば下にフォールバック。処理中はターン完了の行が届いたら解消）。そうでなければ `server/runner.ts` が `claude -p --resume` / `codex exec resume` を `cwd` で detached 起動する。ただし、`server/codex.ts` が `CODEX_HOME/thread-writer-locks/<session>.lock`（補欠で記録時の pid）を見て開いている Codex と判断したら、`exec resume` は active writer と競合するため `codex queue --thread ... --message ...` の終了まで待って開いている会話へ足す。結果は既存のフックが JSONL に足す1行として届くので、返信専用の記録経路は無い。返信できるかの判定は `shared/reply.ts` の `replyBlockedReason()` にあり、サーバの受付と画面の入力欄の出し分けが同じ関数を使う。画面側の送信と「送信中」の判定は `web/src/useReply.ts`（返信先ごとの行数が送信時より増えたら消える）で、セッション画面とフィードが共用する。フィードの返信先は `@` メンションで選ぶ。候補の組み立て（`sessionReplyTargets` がサイドバーの一覧から、`feedReplyTargets` がフィードの行から作り、`mergeReplyTargets` で一覧を先に並べる。一覧のポーリングは `App.tsx` が1回だけ行い、`SessionList` と `FeedView` の両方に渡す）、`@` の検出（`mentionQuery`）、本文に入れる表記（`mentionLabels` / `stripMention`）は `shared/reply.ts` にあり `shared/reply.test.ts` で回す。テストは `createApp(store, distDir, runner)` に `FakeRunner` を渡して実際には起動しない。
- **処理中でも端末には打ち込める。** `app.ts` の返信は `run.running(id)`（`-p` の子プロセス）だけを 409 にし、端末に打ち込んだ返信が処理中（`TerminalReplies`）でもペインが開いていれば通す。TUI が次のターンに回すので、端末で人が続けて打つのと同じ。画面（`ReplyBox`）は `blocked = busy && terminal !== true` で送信を止め、止めたときは Enter を黙って捨てずに理由を出す。フィードは `ReplyTarget.terminal`（`sessionReplyTargets` が `SessionSummary.terminal` から載せる）で判断する（#170）。
- **端末の打ちかけは人の確認のうえでだけ消す。** `promptState()` は `kind`（idle / typed / dialog / unknown）を返し、`typed` のときだけ 409 の body に `code: terminal_typed` と `typed` を載せる（`shared/types.ts` の `ReplyError`）。画面（`useReply` → `ReplaceConfirm`）が確認して `replace_typed: true` で送り直すと、`typeInto()` が `C-u` を送り、再度 `capture-pane` で空を確かめてから貼る。dialog / unknown は消させない。端末に打てない 409 は `can_process: true` を付け、画面に「端末を使わず送る」（`via: 'process'`）を出す。Claude は別プロセスで再開し、開いている Codex は queue へ送る。入力欄は区切り線の直上の `❯` で見て、スラッシュコマンドの候補メニューは `Escape` で閉じてから `C-u`。
- **返信中の許可・質問**（`POST /api/approvals`）: 返信の `claude` に `--mcp-config` で SAI の MCP サーバ（`server/approve-mcp.ts`。stdio、依存ゼロ、`initialize` / `tools/list` / `tools/call` だけ）を足し、`--permission-prompt-tool mcp__sai__approve` で許可が要るたびに呼ばれる。ツールは `POST /api/approvals` で預けて `GET /api/approvals/<id>?wait=1` で待ち、画面の `POST /api/approvals/<id>/answer` の決定をそのまま CLI に返す。預かりは `server/approvals.ts`（メモリ。プロセスが exit したら `drop`、90 秒取りに来なければ捨てる）。文言（`許可待ち: Bash: …`）は `shared/approvals.ts` で、`record.py` の待ちの行と揃える。キーボードは `⌘Enter` で許可・`⌘⇧Enter` で常に許可（`web/src/approvalKeys.ts` の `approvalAction()`。「常に許可」が無いバブルでは `⌘⇧Enter` も許可に落ちる）。受けるのは**描画順の先頭**のバブルだけで、親（`FeedView` / `SessionView`）が `hotkey` を渡して決める。window の keydown を **capture** で張り、拾ったときだけ `stopPropagation()` するので、入力欄（`ReplyBox`）の `⌘Enter` 送信は答え待ちが無いときだけ今までどおり効く。`rev` に答え待ちの集合を混ぜるので画面のポーリングが拾う。Claude だけ（Codex に口が無い）。テストは `server/approve-mcp.test.ts` が実際に子プロセスを立てる。 「常に許可」は画面が `remember: 'local'` を送り、サーバが `shared/approvals.ts` の `alwaysAllowRule()` でルール（`Bash(gh pr:*)` など）を組み立てて `updatedPermissions`（`destination: localSettings`）として CLI に返す。CLI が cwd の `.claude/settings.local.json` に書く。画面はルールを送らない。
- **`/` のスキルの候補**（`GET /api/sessions/<id>/skills`）は `server/skills.ts` の `SkillStore` が `~/.claude/skills/` とそのセッションの `cwd` の `.claude/skills/` から `SKILL.md` を読む（ディレクトリの mtime で覚える。説明だけの書き換えは拾わない）。プロジェクト側が先で、同じ名前はプロジェクトが勝つ。Claude だけ（Codex にスキルの仕組みは無い）。frontmatter の読み方と `/` の検出・絞り込みは `shared/skills.ts`（`parseSkill` / `slashQuery` / `filterSkills`）にあり、`shared/skills.test.ts` で回す。画面は `web/src/useSkills.ts` が `/` を打った時に 1 回だけ取り（一覧のポーリングには載せない）、`ReplyBox` が `@` と同じ候補メニューに出す。選んでも本文を `/<name> ` にするだけで、展開は CLI に任せる。**`:` の絵文字**も同じメニューで、`shared/emoji.ts` の `emojiQuery()` / `filterEmoji()` を使う（サーバは要らない）。選ぶと絵文字そのものを本文に入れるので、Markdown を通さない自分のバブルにもエージェント側にもそのまま出る。`/` と同じく当たりが無ければ開かない（時刻の `14:08:30` で Enter を食べない）。
- **返信に添える画像**（`POST /api/sessions/<id>/attachments`、`GET /api/attachments/<dir>/<name>`）は `server/attachments.ts` の `AttachmentStore` が `~/.agent-feed/attachments/<sha1(ID) の先頭16桁>/<sha1(中身) の先頭16桁>.<ext>` に置く（JSONL には書かない。ID からパスを組み立てない）。**`ReplyRequest.attachments` の絶対パスは信じない**（CLI に渡って読まれるので、`resolvePath()` がそのセッションの置き場のものだけを通す）。受け付け条件と、本文への足し方・取り出し方（`withAttachments` / `splitAttachments`）は `shared/attachments.ts` にあり `shared/attachments.test.ts` で回す。Claude は画像のフラグが無いので本文の末尾にパスを足すだけ、Codex は `-i` でも渡す（`server/runner.ts` の `replyCommand`）。画面は `web/src/useAttachments.ts` が預けて `ReplyBox` が貼り付け・ドロップ・ファイル選択で受け、`Message` / `PendingBubble` が `splitAttachments()` でサムネイル（`AttachedImages`）にする。
- **セッションに効いている許可**（`GET /api/sessions/<id>/permissions`）は `server/permissions.ts` が cwd から**読むだけ**（書き換えは「常に許可」の経路だけ）。読む先は managed / `<cwd>/.claude/settings.local.json` / `<cwd>/.claude/settings.json` / `~/.claude/settings.json` と `SAI_CLAUDE_ARGS` の `--allowedTools`。パスは cwd から固定で組み立て、リクエストからは受け取らない。並びと言い換えは `shared/permissions.ts`（評価は deny → ask → allow で、deny はどのスコープでも allow に勝つ）。行の `permission_mode`（Claude のフックのペイロード）を `aggregate.ts` が `SessionSummary.permission_mode` に出し、ルールが 0 件でも `auto` / `bypassPermissions` なら通ることを画面が併せて出す。3 秒のポーリングには乗せない（見出しの盾を押したときだけ取る）。
- **変更内容の diff**（`GET /api/sessions/<id>/diff`）は `server/diff.ts` がセッションの `cwd` で git を読む（#171）。`base...HEAD`（ブランチの差分）と `HEAD` からの未コミット、追跡外のファイル名。base は `origin/HEAD` → `origin/main` → `origin/master` → `main` → `master` の順にローカルで探す（**`origin/HEAD` は bare clone だと未設定**）。**読むだけのサブコマンドしか呼ばない**（`RealGit.run()` が allowlist で弾く）。`cwd` はセッションの行から取り、リクエストからは受けない。上限は 1 ファイル 200KB / 1 セクション 2MB で、超えたら本文を落として `truncated`（ファイルの一覧は常に全部返す）。unified diff を木にするのは `shared/diff.ts` の `parseUnifiedDiff()`（`shared/diff.test.ts`）で、描画は `web/src/DiffView.tsx`。3 秒のポーリングには乗せず、`DiffButton` を押したときだけ取る。**出し方は幅で変える**（#190）: 広い画面はチャットの右にもう1枚のペイン（`DiffPane`。`main.layout.diff-open` の3列目）、狭い画面は今までどおりモーダル（`DiffModal`）。中身は両方 `DiffBody` で、開いている id は `App.tsx` が持ち（`useNarrow()` で出し分け）、そのセッションを開いている間だけ出す（Esc で閉じる。フィードや別のセッションへ移ると消える）。テストは `Git` を差し替えるか、本物の一時リポジトリを作る（`server/diff.test.ts`）。
- **SAI から返信するときの許可モード**は `SessionMeta.permission_mode`（チャット見出しの `SessionPermissionModeSelect`）。`replyCommand()` が Claude にだけ `--permission-mode` として付ける（運用者の `SAI_CLAUDE_ARGS` より後ろで後勝ち）。**そのターン限りでセッションには残らない**（`--model` と違う。フラグ付きで回したセッションをフラグ無しで再開すると元に戻ることを確かめた）。**端末に打ち込む経路では効かない**（CLI を起動しないのでフラグを渡す先が無い）。選べるのは `acceptEdits` だけで、素通し系（`auto` / `bypassPermissions`）は画面に並べないだけでなく `mergeMeta()` が `400` にする（返信の POST はブラウザから飛ぶため。README「返信と許可」）。一覧は `shared/permissions.ts` の `REPLY_MODES` / `isReplyPermissionMode()` にあり、サーバの検査と画面の select が同じものを見る。
- **返信で使うモデル**は入力欄の送信ボタンの左（`web/src/ReplyModelPicker.tsx`。#193）。押すとメニューが開き、選ぶと `PUT /api/sessions/<id>/meta` の `model` に保存する。候補の組み立てと短い名前は `web/src/modelChoices.ts` の純粋関数（`modelChoices()` / `shortModel()`）で `modelChoices.test.ts` で回す。**閉じているときだけ短く出し、メニューと保存する値は正式名のまま**（`claude-opus-5` と別名の `opus` がどちらも `opus` に見えてしまう）。候補に無い名前は `ModelNameModal`（`normalizeMeta()` で検査）。見出しは `ModelTag` で**使ったモデルを出すだけ**（操作は入力欄の 1 か所）。フィードは `FeedView` がサイドバーの一覧から返信先のセッションを引いて渡す（一覧に無ければ出さない）。
- **表示名・アーカイブ・返信のモデル・一言の性格**（`GET/PUT /api/sessions/<id>/meta`）は `server/meta.ts` の `MetaStore` が `~/.agent-feed/session-meta.json` に持つ（JSONL は触らない）。`createApp` が応答を返すときに `SessionSummary.meta` として載せ、rev にもファイルの状態を混ぜる。**アイコン画像**（`GET/PUT/DELETE /api/sessions/<id>/icon`）は `server/icons.ts` の `IconStore` が `~/.agent-feed/session-icons/<sha1(ID) の先頭16桁>.<ext>` にファイルで持ち（`session-meta.json` には書かない。ID からパスを組み立てない）、`SessionSummary.icon` に `?v=<mtime>` 付きの URL として載せる。受け付ける種類・上限・中身の判定（`sniffImageType`）は `shared/icon.ts` にあり、サーバの受付と画面の「画像を選ぶ」（`MetaEditor`）が同じ値を見る。絵文字のアイコンは廃止済みで、古い `icon` キーは `mergeMeta()` が知らないキーとして捨てる。PUT は**重ねる**（省略は据え置き、空や null は消す）意味で、`shared/meta.ts` の `mergeMeta()` がその正本。画面の入力欄（`web/src/MetaEditor.tsx`）は同じファイルの `normalizeMeta()` で検査する。アーカイブは `archived_at` を載せるだけで、「アーカイブ済みか」は `createApp` が `archived_at >= end` で決めて `SessionSummary.archived` に出す（行が増えれば自動で戻る）。`/api/sessions` は既定でアーカイブ済みを除き（`archived=1` で逆）、`/api/feed` もその行を除く。画面の切り替えは `web/src/useArchive.ts` で、チャット見出し（`ArchiveButton`）とサイドバーの項目（`SessionArchiveButton`）が共用する。
- **自分の表示名とアイコン**（`GET/PUT /api/profile`、`GET/PUT/DELETE /api/profile/icon`）は `server/profile.ts` の `ProfileStore` が `~/.agent-feed/profile.json` に名前を持ち、アイコンは同じ `IconStore` に固定の鍵（`shared/profile.ts` の `PROFILE_ICON_ID` = `me`）で置く。応答の `profile` に載せ、`rev` にも混ぜる。画面はヘッダー右端の `UserMenu` → `ProfileEditor`（モーダル）で編集し、`chatGroups.ts` の `speakerLabel()` が自分側のバブルの名前とアバターに当てる（無ければ「あなた」/「私」）。
- **一言コメント（digest）**は `server/digest.ts`。`SAI_DIGEST=1` のとき、サーバ起動後に増えたターン完了の行を 1〜2 文に言い換え、`~/.agent-feed/digest.jsonl` に追記する（JSONL は触らない）。口は `SAI_DIGEST_PROVIDER` で選ぶ: `claude`（既定。`ClaudeSummarizer` が `claude -p --model haiku --output-format json` に stdin でプロンプトを渡す）か `openai`（`OpenAISummarizer` が `SAI_DIGEST_URL` の `/chat/completions` を Node の `fetch` で叩く。Ollama / LM Studio などローカルの LLM 向け。`SAI_DIGEST_MODEL` 必須、鍵は `SAI_DIGEST_API_KEY`、`<think>…</think>` は `stripThinking()` で落とす）。どちらも `Summarizer`（`summarize(prompt)`）の実装で、`digesterFromEnv()` が環境変数から組む（設定の間違いはサーバを落とさず stderr に出して無効のまま）。応答時に `FeedRow.summary` / `SessionSummary.last_summary` として載せ、rev にも混ぜる。プロンプトと MBTI の口調表は `shared/persona.ts`（`digestPrompt()`）。性格は行ごとに `personaResolver()` が決める: セッションのメタ（`session-meta.json` の `persona`。チャット見出しの `SessionPersonaSelect`）にあればそれ、無ければ全体の既定（`server/settings.ts` の `SettingsStore`、`~/.agent-feed/settings.json`、`GET/PUT /api/settings`。ヘッダの `PersonaSelect`）。子プロセスには `AGENT_FEED_SKIP=1` を渡して `record.py` に記録させない（`--bare` は OAuth を読まないので使えない）。画面は `Message.tsx` が一言 + 「詳細」で元の本文を開く。一言の中の `#123` / `owner/repo#123` / Linear の `PGR-123` / URL は `shared/refs.ts` の `linkifyRefs()` が Markdown の `Inline` の木にしてリンクにする（`#123` の向き先は行の `remote`。`record.py` が origin を `https://host/owner/repo` に正規化して載せる。Linear の workspace は `settings.json` の `linear_workspace`）。`shared/refs.test.ts` で回す。テストは `Summarizer` を差し替えた `Digester` を `createApp` の第 6 引数に渡す。
- **別ターミナルの `pnpm build` に追従する。** サーバは `web/dist/` を毎回ディスクから読み、`/api/*` に `X-SAI-Build`（`dist/index.html` の mtime）を付ける。`web/src/api.ts` の `watchBuild` がポーリングのついでにそれを見て、変わっていたら `location.reload()` する（`pnpm dev` 中は HMR に任せて何もしない）。サーバ側の再起動は `pnpm start:watch`。
- **ビルドが古いことはサーバが判定して画面に出す。** `server/buildFreshness.ts` が `web/dist/index.html` と `web/src` / `web/index.html` / `shared`（`*.test.ts` を除く）の mtime を 30 秒に1回比べ、`/api/sessions` と `/api/feed` の `build_stale` に載せる（`rev` にも混ぜる）。`App.tsx` はそれでヘッダの下にバナーを出す（`pnpm dev` では出さない）。git は叩かない。

## 設計上の前提（変えるときは README / docs も直す）

- **`record.py` は必ず exit 0。** フックが非0で終わるとエージェント本体を止めるため、失敗は黙って諦める（`AGENT_FEED_DEBUG=1` で `record-errors.log` に残す）。SIGALRM による15秒の自殺タイマーも入っている。stdin より先に argv を見るのも意図的（Codex 経路で閉じられない stdin を read してハングしない）。
- **セッション終了は掴めない**ので、両エージェントとも「ターン完了」を1行として記録し、セッションはサーバ側の `aggregate()` でまとめる。
- **Codex の notify にはセッションIDが無い**ので、`~/.codex/sessions/` の rollout ファイルを cwd で引く（`session_source: rollout`）。引けなければ `(repo, cwd, agent)` が同じで30分以内の前行と同じセッションにする（`synth`）。`session_index.jsonl` は壊れていることがあるので索引は使わない。resume/queue 後の `input-messages` には過去の入力がすべて並ぶため、`user_text` には末尾の今回分だけを使う（今回分が text block の配列なら、その中は連結する）。Codex はタイトル生成などの内部の LLM 呼び出しでも notify を鳴らす（ID 無し・rollout にも無い）ので、`record.py` の `is_codex_internal_turn()` が中身（既知のプロンプトの書き出し、JSON だけの返答 + `Do not answer the request`）で落とす。
- **セッションのタイトルは一番新しい `user_text` に追従する。** `aggregate.ts` の `sessionTitle()` が新しい行から遡って最初の `user_text` の1行目を使うので、画面から返信しても端末で続きの指示を打っても、次のターンが記録された時点で説明文が変わる。フィードの `@` メンション候補のラベル（`feedReplyTargets`）も同じ順。`user_text` が1行も無いときだけ `first_user_text` に落ちる。
- **`first_user_text` は毎行に載せる。** フォールバック時の集計は最古の行の値を使うので、`days` の窓から1行目が落ちてもタイトルが残る。
- **自分の入力は `UserPromptSubmit` の行で先に届く。** `record.py` は Claude の入力のたびに `user_text` だけの行（`event: UserPromptSubmit`、`text` は空）を書き、続く `Stop` の行にも同じ `user_text` が載る。Claude Code が差し込む入力（バックグラウンドのタスク完了の `<task-notification>`。transcript では `promptSource: system`）は人の入力ではないので `user_text` にしない（`record.py` の `_is_system_prompt()`）。画面（`web/src/chatGroups.ts`）は同じエンティティで直前の入力行と同じ文なら `Stop` 側の自分バブルを出さない。`turns` と「返信が終わった」の判定は `Stop` の行だけで数える（`eventKind() === 'turn'`）。画面から返信したときの仮バブルは、入力の行が届いたら `promptArrived()` で本文を消して「処理中」の1行にする。
- **一覧の絞り込みは `project`（どのリポジトリか）で、`repo` ではない。** `repo` は git の toplevel の basename なので、bare clone の worktree（`…/sai.git/dev-min`）では **worktree 名**になり、worktree ごとに 1 セッションずつ並んで絞り込みにならない（#163）。`record.py` の `git_project()` が `remote` の `owner/repo`、無ければ `--git-common-dir` からリポジトリ名を取って行に載せる。**`rowProject()`（`shared/project.ts`）は `project` → `remote` だけを見て、分からなければ空を返す**（`repo` には落とさない。worktree 名を混ぜると絞り込みの候補が汚れる。#182）。空のセッションは `server/project.ts` の `ProjectResolver` が **cwd で git を読んで埋める**（`remote get-url origin` → 無ければ `--git-common-dir`。cwd をキーにキャッシュするので 3 秒のポーリングで叩き直さない）。それでも分からなければ空のままで、**絞り込みの候補には出さず**、一覧の表示だけ worktree 名に落ちる。**`repo` の値は変えない**（エンティティIDが変わると `session-meta.json` のキー・アイコン・アーカイブ・URL がずれる）。
- **エンティティの単位は (セッション, リポジトリ)。** IDは `<セッション>@<リポジトリ>`（セッションが取れない行は `unknown-<日付>`）。キーの作り方は `shared/entity.ts` の `entityId()` にあり、サーバの集計（`aggregate.ts`）・詳細APIの行の絞り込み（`app.ts`）・画面のリンク（`Chat.tsx`）が全部これを使う。別々に組み立てるとリンク切れになるので必ず共有関数を通す。
- 日付の切り方は `Asia/Tokyo` 固定（`record.py` の `tz()` と `shared/entity.ts` の `TIME_ZONE`）。
- **SAI は外に出さない。** `127.0.0.1` / `localhost` / `::1` 以外への bind は `main.ts` が拒否する。中身は作業内容そのものなので、デプロイ・ホスティング・Slack への送信はしない。出してよいのは tailnet までで、`tailscale serve` 経由だけ（bind は変えない、funnel は使わない）。Serve の `Tailscale-User-Login` は `server/auth.ts` の `Authenticator` が `tailscale whois <X-Forwarded-For>` で突き合わせ、合わなければ全リクエスト 401。ヘッダ無しはループバックからだけ通す。`createApp(..., auth)` で `Whois` を差し替えてテストする。Serve 経由は `Origin` が `https://` になるので `isCrossOrigin()` は `X-Forwarded-Proto` を見る。
- **返信の POST は同一オリジンのみ。** ブラウザから任意の `cwd` でコマンドが走るので、`app.ts` の `isCrossOrigin()`（`Origin` / `Sec-Fetch-Site`）は外さない。SAI 自身は起動するコマンドに権限のフラグを付けない（非対話なので許可ダイアログは出せず、未許可のツールは拒否される）。運用者が `SAI_CLAUDE_ARGS` / `SAI_CODEX_ARGS` で明示的に渡すのは可で、それは `docs/screen.md` の「返信と許可」に書いてある範囲（ツール単位の `--allowedTools` を勧め、バイパスは CSRF の観点から勧めない）。
- **承認の答え（`POST /api/approvals/<id>/answer`）も同一オリジンのみ。** ここが通ると別サイトから「許可」が押せる。`POST /api/approvals`（預ける側）は返信を処理中のエンティティの分しか受けない。
- **返信のプロセスの失敗は `replying` に載せて画面に出す。** `ProcessRunner` は `exit` のコードを見て、0 以外なら `Replying.failed`（`code` と `reply.log` のそのターンぶんの末尾。`tailFrom()` が offset 以降の末尾だけ読む）を付けて `FAILED_TTL_MS`（2 分）だけ残す。付いている間は `running()` が false（次の返信を止めない）、`persist()` も書かない。`revWith()` が `failed.code` を混ぜるので画面のポーリングが拾い、`useReply` が `replyFailureMessage()` で出す（#172）。
- **「処理中の返信」はメモリと `~/.agent-feed/replying.json` の両方。** `server/runner.ts` の `ProcessRunner` が `start` で書き `exit` で消し、起動時に読んで生きている pid の分だけ引き取る（見るたびに `kill(pid, 0)` で生存確認）。サーバの再起動で「処理中」を忘れて同じセッションに返信が二重に走った（#100）ため。承認（`Approvals`）はメモリだけ。
- 履歴（`*.jsonl`、`.agent-feed/`、`sessions/`）はコミットしない。`.gitignore` 済み。

## 環境変数

| | |
| --- | --- |
| `SAI_HOME` | このリポジトリの場所。README のフック設定例（`settings.json` の `env`）が使うだけで、コードは読まない |
| `AGENT_FEED_DIR` | JSONL の置き場（既定 `~/.agent-feed`）。record.py とサーバの両方が見る |
| `AGENT_FEED_DEBUG` | `1` で record.py の例外をログに残す |
| `CODEX_HOME` | Codex のホーム（既定 `~/.codex`） |
| `SAI_PORT` | サーバの既定ポート（既定 `8787`）。`web/vite.config.ts` の `/api` の proxy 先もこれ（判定は `shared/port.ts`。`--port` は Vite から見えない） |
| `SAI_TERMINAL` | `0` で「tmux のペインに打ち込む」を切る。Claude と閉じた Codex は別プロセス、開いている Codex は queue |
| `SAI_TMUX_BIN` | ペインに打ち込むときの `tmux` の実行ファイル（既定は PATH の `tmux`） |
| `SAI_GIT_BIN` | 差分を読むときの `git` の実行ファイル（既定は PATH の `git`）。読むだけのコマンドしか呼ばない |
| `SAI_CLAUDE_BIN` / `SAI_CODEX_BIN` | 返信で起動する CLI の実行ファイル（既定は PATH の `claude` / `codex`） |
| `SAI_TAILSCALE_BIN` | tailnet 経由の認証の `whois` に使う `tailscale`（既定は PATH、無ければ macOS の GUI 版） |
| `SAI_CLAUDE_ARGS` / `SAI_CODEX_ARGS` | 返信のコマンドに足す引数（`--allowedTools "Bash(gh *)"` など。シェル風に割る。`server/runner.ts` の `splitArgs()`）。Claude は先頭に置く（`--allowedTools` は可変長で、後ろだと本文を飲む） |
| `AGENT_FEED_SKIP` | `1` で record.py は何も記録しない（一言を作る `claude -p` に付ける） |
| `SAI_DIGEST` / `SAI_DIGEST_MODEL` | `1` で一言コメントを作る（既定オフ）。モデルは `claude` なら既定 `haiku`、`openai` なら必須 |
| `SAI_DIGEST_PROVIDER` / `SAI_DIGEST_URL` / `SAI_DIGEST_API_KEY` | 一言を作る口（`claude` 既定 / `openai`）、`openai` の base URL（既定 Ollama の `http://127.0.0.1:11434/v1`）、任意の鍵 |
| `SAI_APPROVE` | `0` で返信中の許可・質問を画面で答える配線（`--mcp-config` + `--permission-prompt-tool`）を付けない |

コードが読む環境変数がこの表と README の表の両方に載っていることは `server/docs.test.ts` が見る（変数を足したら両方の表に足す）。
