# メタ・プロフィール・未読・スキルの仕組み

CLAUDE.md から移した「どう動くか」。守る決まりは CLAUDE.md、経緯は [history/meta.md](../history/meta.md)。

ファイルの形（`session-meta.json` / `profile.json` / `read-marks.json` / アイコンの置き場）は [data.md](../data.md)、見え方は [screen.md](../screen.md)、口の形は [api.md](../api.md)。ここにはコードの側の話を置く。

## セッションのメタ

- 表示名・アーカイブ・返信のモデル・一言の性格（`GET/PUT /api/sessions/<id>/meta`）は `server/meta/meta.ts` の `MetaStore` が `~/.agent-feed/session-meta.json` に持つ（JSONL は触らない）。
- `createApp` が応答を返すときに `SessionSummary.meta` として載せ、rev にもファイルの状態を混ぜる。
- PUT は重ねる（省略は据え置き、空や null は消す）意味で、`shared/meta.ts` の `mergeMeta()` がその正本。画面の入力欄（`web/src/MetaEditor.tsx`）は同じファイルの `normalizeMeta()` で検査する。

### 表示名を Claude の CLI にも渡す（#391）

- `claudeHead()` が `-n` を付けるので、端末のタイトルと `/resume` のピッカーにも同じ名前が出る。
- 表示名が付いていないセッションには渡さない（名前はセッションに残るので、端末で付けた名前を空で上書きしない）。
- モデル・許可モードと同じく運用者の `SAI_CLAUDE_ARGS` より後ろ（後勝ち）。渡す先は Claude だけ（Codex / OpenCode に同じ口は無い）。
- 名前が `-` で始まっても CLI は次の argv を値として取るので、フラグに化けない。


### 同じ名前のセッションを見分ける（#572）

- 同じ project（無ければ worktree 名）の中で、同じ名前（表示名 → 題名 → ID）のセッションが 2 つ以上あるときだけ、`SessionSummary.label_suffix` に短い添え字を付ける（`shared/sessionLabels.ts` の `labelSuffixes()`）。重なっていなければ付けない。
- 付けるのは `server/app.ts` の `sessionsWithMeta()` の 1 か所。名前を出す所（要対応の行・サイドバー・`⌘K`・`@` の返信先・通知・本文の検索・チャットの話者名・狭い見出し・PR 画面の書いたセッション）は全部 `withSuffix()` を通す（別々に組み立てると、片方だけ区別が付かない）。**リンクや返信先は今までどおり ID で引く**。
- 添え字は**始まった日**（`9/2〜`）。組の中で日が重なる（か取れない）ものだけ **ID の頭**（`a3d0`。重ならない長さまで伸ばす）。
- **重なりも始まりも、呼び出しの窓ではなく `LABEL_START_DAYS`（90 日）の決まった窓の集計で決める**（`labelSuffixesNow()`。#578 のレビュー。一覧は 7 日・詳細は 30 日・フィードは 3 日なので、窓ごとに決めると同じセッションが見出しでは ID の頭、サイドバーでは日付になった）。一覧の `start` は窓の中の最初の行なので、広い窓で引くと本当の始まりになる。集計は行が変わったときだけ組み直され（実データの 90 日ぶんで 1 回 40ms ほど）、その rev と表示名の rev が同じなら覚えた添え字を返す。
- 同じセッションの別の worktree（`<sid>@main` / `<sid>@feat`）は ID の頭では分けられないので、worktree の名前を足す（`a3d0@feat`）。
- 名前を付けるとき（`MetaEditor`）、同じ project のアーカイブ済みでないほかのセッションに同じ表示名があれば「同じ名前のセッションがあります（9/2〜、285 ターン）」と出す（`sameNamed()` / `sameNameNote()`）。**止めはしない**。見るのは画面の一覧（サイドバーの絞り込みに従う）。

### アーカイブ

- `archived_at` を載せるだけ。「アーカイブ済みか」は `createApp` が `archived_at >= end` で決めて `SessionSummary.archived` に出す（行が増えれば自動で戻る）。
- `/api/sessions` は既定でアーカイブ済みを除き（`archived=1` で逆）、`/api/feed` もその行を除く。
- 画面の切り替えは `web/src/useArchive.ts` で、チャット見出し（`ArchiveButton`）とサイドバーの項目（`SessionArchiveButton`）が共用する。
- 合成 ID（`synth`）のセッションも普通にアーカイブできる（#248）。合成 ID は `record.py` の `synth_session()` が記録時に決めて行に書き込み（続きの行は前の行の文字列をそのまま読む）、`entityId()` は `session` が空のときしか `ts` を見ないので、`days` の窓でも集計でも ID は動かない。サーバ側には元から制限が無い。
- 返信の禁止（`replyBlockedReason()` の `synth`）は別で、そのまま残す（アーカイブは表示の都合、返信は再開できるかの話）。

## アイコン画像（server/meta/icons.ts）

- `GET/PUT/DELETE /api/sessions/<id>/icon`。`IconStore` が `~/.agent-feed/session-icons/<sha1(ID) の先頭16桁>.<ext>` にファイルで持つ（`session-meta.json` には書かない。ID からパスを組み立てない）。`SessionSummary.icon` に `?v=<mtime>` 付きの URL として載せる。
- 受け付ける種類・上限・中身の判定（`sniffImageType`）は `shared/icon.ts` にあり、サーバの受付と画面の「画像を選ぶ」（`MetaEditor`）が同じ値を見る。
- 絵文字のアイコンは廃止済みで、古い `icon` キーは `mergeMeta()` が知らないキーとして捨てる。

### アイコンの履歴

- `IconHistory`。`<feed dir>/icon-history/<sha1(中身) の先頭16桁>.<ext>` と、使った時刻と「取り込み済みか」だけを持つ `icon-history.json`。中身で名前を付けるので同じ画像は 1 つにまとまる。
- 入れるのは `PUT …/icon` と `PUT /api/profile/icon` で置けた画像。外しても（DELETE）履歴には残す。
- 初めて使うときにいまの `session-icons/` を 1 度だけ取り込み、取り込んだことを json に覚える（覚えないと、履歴から消したものが次の起動で戻る）。
- 履歴から付けるのは `?history=<key>` で、サーバが自分の置き場から読む（`isHistoryKey()` が `^[0-9a-f]{16}$` だけを通し、パスは受けない）。
- 履歴から消しても、`session-icons/` の別のコピーなので付いているアイコンは残る。セッションと自分で履歴は 1 つ。
- 画面は `IconHistoryPicker`（開いたときだけ `GET /api/icon-history` を取る。消すのは 2 回押し＝`web/src/iconHistory.ts` の `nextRemoval()`）。
  - 消したあとはモーダルにフォーカスを戻す。閉じたあとも呼び出し側にフォーカスを戻す。
  - `ProfileEditor` の Esc は `stopPropagation()` する（あちらはモーダルが残るので、止めないと閉じると同時にセッションから飛ぶ）。
  - 付けるのに失敗した理由は履歴のモーダルの中に出す（後ろの編集欄に書くと背景に隠れる）。

## 自分の表示名とアイコン（server/meta/profile.ts）

- `GET/PUT /api/profile`、`GET/PUT/DELETE /api/profile/icon`。`ProfileStore` が `~/.agent-feed/profile.json` に名前を持ち、アイコンは同じ `IconStore` に固定の鍵（`shared/profile.ts` の `PROFILE_ICON_ID` = `me`）で置く。
- 応答の `profile` に載せ、`rev` にも混ぜる。
- 画面はヘッダー右端の `UserMenu` → `ProfileEditor`（モーダル）で編集し、`chatGroups.ts` の `speakerLabel()` が自分側のバブルの名前とアバターに当てる（無ければ「あなた」/「私」）。

## 未読の印

- `PUT /api/sessions/<id>/read`（同一オリジンのみ）。`server/meta/reads.ts` の `ReadStore` がセッションごとに「読んだ最後の返答の時刻」を 1 つだけ `<feed dir>/read-marks.json` に持つ（localStorage には置かない）。
- 判定は `shared/unread.ts`（`unreadCounts()` / `nextMark()` / `unreadFromMark()`）。数えるのはターン完了の行だけ。
- `sessionsWithMeta()` が応答のたびに窓の中の行から数えて `SessionSummary.unread` / `read_at` に載せ、印のファイルの状態を rev に混ぜる。
- 印の無いセッションはファイルを作った時刻 `since` まで読んだ扱い。既読は前にしか進めない。戻すのは返答の `⋯` の「ここから未読にする」（`back: true`。その返答の 1 秒前。行の `ts` は秒まで）だけ。
- 既読になるのはセッション画面で最下部が見えているときだけ（`Chat` の `onSeenBottom`）。送るかは `web/src/unreadMarks.ts` の `readToSend()`（同じ時刻は 2 度送らない・「ここから未読にする」のあとはそのセッションを離れるまで送らない）。
- 「ここから未読」の線は開いたときの印に引く（`SessionView` が描画中に覚える。今の印に引くと読んだそばから消える）。位置は `firstUnreadKey()`。一覧の印は `UnreadTag`。

## `/` のスキルの候補

- `GET /api/sessions/<id>/skills`。`SkillStore` が `~/.claude/skills/` とそのセッションの `cwd` の `.claude/skills/` から `SKILL.md` を読む（ディレクトリの mtime で覚える。説明だけの書き換えは拾わない）。プロジェクト側が先で、同じ名前はプロジェクトが勝つ。
- frontmatter の読み方と `/` の検出・絞り込みは `shared/skills.ts`（`parseSkill` / `slashQuery` / `filterSkills` / `skillInvocation`）にあり、`shared/skills.test.ts` で回す。
- 画面は `web/src/useSkills.ts` が `/` を打った時に 1 回だけ取り（一覧のポーリングには載せない）、`ReplyBox` が `@` と同じ候補メニューに出す。
- 候補を選ぶと Codex は `$<name> `、Claude / OpenCode は `/<name> ` を本文に入れ、展開は CLI に任せる。Grok は空。

### Codex（#402）

- リポジトリ側は `SkillStore` が `<cwd>/.codex/skills/` と `<cwd>/.agents/skills/` から読む（`.claude/skills/` は Codex が読まないので出さない）。
- cwd に依らない分（`$CODEX_HOME/skills/`・プラグイン・組み込み）は app-server の `skills/list`（`CodexApp.skills()`。60 秒覚える）から足す。
- `skills/list` は app-server を起こした場所のリポジトリのスキルも返すが、SAI の app-server はサーバの cwd で長く生きている 1 本なので、`scope` が `repo` のものは `shared/skills.ts` の `parseCodexSkills()` が落とす。
- `SAI_CODEX_APP_SERVER=0` のときは聞きに行かない（リポジトリ側だけ）。

### OpenCode（#393）

- `OpencodeServer.skills()` が `GET /command?directory=<セッションの cwd>`。この 1 本でスキルもスラッシュコマンドも返るので `/skill` とは混ぜない（混ぜると同じものが 2 回出る）。
- `directory` を渡す（サーバは homedir で動いているので、渡さないとサーバ側の顔ぶれになる）。
- 応答からはプロジェクト側かどうかが分からないので、スキルは `source: 'user'` に寄せて印を付けず、コマンドだけ `source: 'command'` にして画面が「コマンド」の印を出す（`shared/skills.ts` の `opencodeSkills()`）。
- `SAI_OPENCODE_SERVER=0` なら聞きに行かない（`/` の候補のためだけにサーバを起こさない）。取れなければ空。

### `:` の絵文字

- 同じメニューで、`shared/emoji.ts` の `emojiQuery()` / `filterEmoji()` を使う（サーバは要らない）。選ぶと絵文字そのものを本文に入れる。
