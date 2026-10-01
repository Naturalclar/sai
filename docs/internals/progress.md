# 処理中の手順の仕組み

CLAUDE.md から移した「どう動くか」。守る決まりは CLAUDE.md、経緯は [history/progress.md](../history/progress.md)。

画面から見た振る舞いは [screen.md](../screen.md) の「処理中の間は、いま何をしているかが出る」と「端末で開いた Claude が質問で止まると…」、応答の形は [api.md](../api.md) の `GET /api/sessions/<id>/progress` と詳細の `question`。

## transcript / rollout を読む

- `server/local/progress.ts` の `ProgressReader` が Claude の transcript（`~/.claude/projects/<cwd の英数字と - 以外を - に>/<session>.jsonl`。組み立てた名前に無ければ projects の直下を 1 段探す）と Codex の rollout（`CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<session>.jsonl`）の末尾だけを読む
- `shared/progress.ts` の `claudeProgress()` / `codexProgress()` が最後のターンの手順（ツール / 考え中 / 返答）にする（`shared/progress.test.ts`）
- ターンの区切り: Claude は人の入力（`isMeta` / 要約でない user の行）と assistant の `stop_reason`（`tool_use` なら続き、`end_turn` / `stop_sequence` なら閉じた）、Codex は `task_started` / `task_complete`
- 64KB から倍々に、ターンの始まりが見えるまで（上限 4MB）読み、`(mtime, size)` が変わらなければ組み直さない
- パスは行の `cwd` と、エンティティ ID から取ったセッション ID（`sessionOf()`。`/` や `.` を含む形と `unknown-` は空）で組み立てる。別のマシンのセッション（`isRemoteHost()`）は空

## active

- `progressActive()`: 「ターンが閉じておらず、走っているツールが 3 時間以内に始まっているか、最後の書き込みが 10 分以内」

## claude agents --json で打ち消す

- `server/local/claudeAgents.ts` の `ClaudeAgents`。出力は `{ pid, cwd, sessionId, kind: interactive|background, status: idle|busy, name, startedAt }` の一覧
- `status: busy` が 1 つも無いと分かったときだけ `active` を false にし、`rev` にも印を付ける（同じ rev だと画面が描き直さない）
- 同じ `sessionId` の行が複数出る（端末の TUI が `idle`、SAI が `-p --resume` で起こした子が同じ ID で `busy`）ので、1 つでも busy なら回っている（`busyIn()`）
- 全体で 1 回叩いて 3 秒覚え、返る前に来た呼び出しは走っている 1 本を待つ（#433）
- 詳細の `backgroundOf()`（`--bg` のセッションか）は、前に引いた一覧があれば待たずに `peekBackground()` で返す（#592。引き直しは裏で続く。引けないまま `AGENTS_PEEK_MAX_MS` = 30 秒を過ぎたら「分からない」に戻す）。返信の直前（`launch()`）は今までどおり引き直して待つ
- `claude` が無い・古い・時間切れ・壊れた出力は `undefined`（分からない）で、transcript の判定を使う（`GhPr` と同じ作法）。`SAI_CLAUDE_AGENTS=0` で丸ごと切れる
- Claude だけ

## OpenCode の読んだ量

- `OpencodeServer.context()` が `GET /session/<id>/message?limit=10` の一番新しい、入力が 0 でない返答の `tokens` の `input + cache.read + cache.write` を `shared/progress.ts` の `opencodeContext()` で読む。手順は空のまま
- 立っているサーバにだけ聞き（`todos()` と同じ `live()`）、`ProgressReader` が `OPENCODE_CONTEXT_TTL_MS`（10 秒）覚える（`sai_sessions` は相手の数だけ一度に聞く）
- `createApp` が `progress.useOpencode()` で繋ぐ。これで #311 の予算がそのまま効く

## OpenCode の段取り

- `OpencodeServer.todos()` が `GET /session/<id>/todo` と `/children`
- 応答は `[{"content":"調べる","status":"completed","priority":"medium"}, …]` で `id` は無い（並びがそのまま順番。読み方は `shared/todos.ts` の `opencodeTodos()`）
- `status` は `pending` / `in_progress` / `completed` / `cancelled`。`cancelled` は済みにも残りにも数えない
- `children` は `Session` の配列が返るが、まず数だけ出す（木を描くのは後で。`title` に `math calculation (@general subagent)` のような名前が入る）
- 立っているサーバにだけ聞く（#421 と同じ `live()`）ので、実際に出るのは SAI から返信したセッション
- 中身は `rev` にも混ぜる（同じ rev だと画面が描き直さない）
- 画面は `web/src/ProgressTodos.tsx`

## ターン完了の行が落ちた印（#614）

- 判定は `shared/stopMissing.ts`。`stopMissingCandidate()` が行だけで候補を絞り（Claude・`last_kind === 'resume'`・`last_user_ts === end` = 最後の行が入力の載った入力の行・`STOP_MISSING_AFTER_MS` = 60 秒たっている）、`stopMissing()` が transcript と突き合わせる。
- transcript の側は `ProgressReader.read()` が返す `closed_at`（Claude だけ。ターンの始まりを見ていて・閉じていて（`end_turn`）・手順があるときの、最後の手順の時刻）。**入力の行より後に閉じていて、閉じてから 60 秒たっている**ときだけ印。回っている・Esc で止めた（`[Request interrupted` が次の入力として開く）・途中から読んだ・読めない、は `closed_at` が無いので出ない。
- 載せるのは `sessionsWithMeta()`（一覧・詳細・要対応が同じものを見る）。候補のときだけ transcript を読む（普段は 0 件）。別のマシンのセッションと、SAI が回しているセッション（`mcpBusy()`）は見ない。同じセッション ID のターン完了の行が、その入力より後に**別のエンティティ**（ターンの途中で別の worktree に移った）に載っていれば出さない（transcript はセッション ID で引くため）。時間で出る印なので、出しているセッションの id を rev に混ぜる。
- **行は書かない・補わない**。`turns`・未読・`todoItems()` は触らない（数えるのはターン完了の行だけ、のまま）。

## 画面

- 処理中のセッションを出している間だけ `web/src/useProgress.ts` が 3 秒おきに取る（一覧のポーリングには乗せない）
- `ProgressSteps` が仮バブルの「処理中 N分」の横にいまの手順を 1 行、押すと直近の手順を出す。送った時刻より前に始まった手順は `stepsSince()` で落とす（新しい入力が transcript に届く前は、最後のターンが前のターンのままなので）
- セッション画面は、`replying` が無くても、行の上で最後が人の入力（`web/src/openPrompt.ts` の `openPromptSince()`）かつ `active` なら「処理中」を出す（端末で打ったターン）
- フィードは `FeedPendingBubble` がバブルごとに取る（端末で打ったターンはフィードには出さない）

## 端末の Claude の質問の選択肢

- `claudeProgress()` が今のターンで `tool_result` の付いていない一番新しい `AskUserQuestion` を `ParsedProgress.question`（`PendingQuestion`: `input` そのまま・`asked_at`・`text` = `approvalText()`）に持つ（答え・人の入力で消す）
- `app.ts` の `pendingQuestion()` が詳細の応答の `question` に載せる。載せるのは `session.waiting` がその `text` と同じときだけで、Claude・このマシン・SAI が回している `claude -p` でないときに限る
- `question.asked_at` を詳細の rev に混ぜる（transcript と待ちの行の書かれる順が前後するので）
- 画面は `Chat` が `web/src/terminalQuestion.ts` の `questionsFor()`（同じ文の、まだ解消していない待ちのバブルだけ。`terminalQuestion.test.ts`）で選び、`Message` の待ちのバブルの下に `QuestionPreview` を読むだけで出す
- まだセッション画面だけ（フィード・要対応は出さない）。行に選択肢を載せる案は #334（行から出す分は CLAUDE.md の record.py の項）
