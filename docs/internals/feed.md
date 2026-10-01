# feed の仕組み（record.py / OpenCode のプラグイン / Grok）

CLAUDE.md から移した「どう動くか」。守る決まりは CLAUDE.md、経緯は [history/feed.md](../history/feed.md)。

## feed/record.py

行の形（各フィールドの中身）は [data.md](../data.md)、フックごとに何を書くかは README の「フック」の表。ここにはそれ以外の、コードの側の話を置く。

### 役割とエージェントの見分け

- Python 3.9+ 標準ライブラリのみ（理由は README）。集計も表示もしない。
- どのエージェントかは payload の形で当てるが、`--agent <名前>` と名乗られていればそちらが勝つ（`agent_from_argv()`。#209）。OpenCode のプラグインは payload を自分で組み立てるので形では当てられない。
- Claude のフック名がそのまま `event` に載る。`Stop` 以外に「人を待って止まった」行（`PermissionRequest` / `PreToolUse` / `Notification`。`text` は `許可待ち: Bash: …` のような要約）と「再開した」行（`UserPromptSubmit`。直前が待ちのときだけ）も書く。
- 待ちのフックでは stdout に何も出さない（`decision` を出すと許可の判断に触る）。
- `SessionEnd` は「終わりの行」（#385。`end_text()`。`text` は `セッション終了: 会話をリセット（/clear）`）。

### 「直前の行」の選び方

- 「直前の行」は 2 日ぶんのファイル（`_recent_rows()`。自分のマシンのぶんだけ。#113）から `ts` で一番新しいものを採る（#439。`_latest_row()`）。
- これを見るのは 3 つ: 同じ待ちを重ねない（#48 の「6 秒後の補欠」）・再開の行を書くか・合成セッションを続けるか。
- 2 日ぶん見るのは、夜に許可待ちで止まって日付が変わってから答える回に要るため。
- 同じ秒の行はファイルの順のまま「あとに書かれた方」を採る（`permission.asked` / `replied` は競走して逆順に書かれる）。

### `event` の読み方（`shared/events.ts`）

- `event` の読み方（turn / waiting / idle / resume / other）は `shared/events.ts` の `eventKind(event, text)` に 1 つだけあり、`aggregate.ts` の `turns` / `waiting` / `idle` / `last_text` と画面の待ちバブル（`chatGroups.ts`）が同じ判定を使う。
- `idle_prompt` / `agent_needs_input`（`入力待ち`…）は待ちではなく `idle`（#438）。`eventKind()` が `Notification` の `text` の接頭辞で分ける。行の形は変えないので `RECORD_VERSION` は上げていない。
- `text` は省略できない（#438）。`Notification` は「詰まっている（許可待ち）」と「終わって放置されている（`入力待ち`）」の両方で鳴るので `event` だけでは分けられず、既定値を持たせると渡し忘れが黙って「全部 `waiting`」に戻る。
- `turn` は名指しで、知らない `event` は `other` に落とす（#235。`shared/events.test.ts`）。`record.py` はフック名や notify の `type` をそのまま載せるので、`SubagentStop` / `session-configured` のような行が実際に書かれうる。
- `other` は消費側 6 か所のうち 5 か所（`=== 'turn'` の比較）で自然に落ちるが、`chatGroups.ts` だけは明示的に捨てる（早期 return が無いとターン完了の経路に落ちてバブルになる）。
- `unknown` は `detect_event()` が今も返す値なので `turn` として名指しで残す。

### Claude の `text`（そのターンの返答）

- Claude の `text` は「そのターンの返答」で、前のターンには遡らない（#467。`last_assistant_text()` → `_turn_assistant_text()`）。ターンの境目は `_is_prompt_row()`（`last_turn_thinking()` が使っているのと同じ判定）。
- Claude の `Stop` の payload には返答が載っていない（Codex の `last-assistant-message` / Grok の `lastAssistantMessage` と違う）ので transcript を読むしかなく、`Stop` フックはそのターンの最後の行が transcript に書かれる前に走るので、Claude だけこの競走に当たる。
- そのターンのいちばん新しい本文を返し、それが閉じた行（`end_turn` / `stop_sequence`。`shared/progress.ts` と同じ 2 つ）でなければ現れるまで `ASSISTANT_WAIT_S`（2 秒）待つ。現れなければ途中の地の文か空を返す（空の行は正直だが、前回の返答は嘘になる）。
- 古い閉じた行を先に返してはいけない（`stop_sequence` は Claude Code の合成通知「You've reached your … limit」のことがあり、そのあともターンが続くことがある。先に返すと本物の返答を押しのける）。
- 待つ間は `_file_signature()`（size と mtime）が変わったときだけ読み直すが、印は読む前のものを持ち越す（読み終わってから stat すると、読んでいる最中に着いた行がその印に含まれて次の比較で「増えていない」になり、永久に拾えない）。
- 追記が止まったら `ASSISTANT_IDLE_S`（1.2 秒）で切り上げる（揃っているファイルは 1 行も増えないので、閉じた行が来ないターンを上限いっぱい待たない）。
- 読めない transcript は待たない。
- **transcript は末尾から要る分だけ読む**（#613。`_iter_jsonl_reversed()`。1MB ずつ後ろから読み、行ごとに `json.loads`）。本文・入力・思考・モデルの 4 つは同じ「最後のターン」を辿るので、読んだ行は `_tail()` が覚えて使い回す（`_Tail`。ファイルの大きさと mtime が変わったら読み直すので、待っている間に着いた行も拾う）。行の読み方（空行・壊れた行・dict でない行は飛ばす）は頭から読む `_iter_jsonl()` と同じで、こちらは題名用の `first_user_text()`（先頭 400 行まで）と Codex の rollout が使う。
- 待つのはターン完了（`Stop`）の行を書くときだけで、ターンの途中で鳴るフック（`SubagentStop` など）では待たない（エージェント本体を 2 秒止めてしまう）。
- テストの作りものは `claude_entries()` が `stop_reason` を埋めて実データに寄せる（付け忘れると毎回 2 秒待つ）。

### 締切に間に合わなくても行は書く（#613）

- 時計は 3 つ。`GIT_BUDGET_SECONDS`（6 秒。過ぎたら `_git()` はもう起こさず空を返す）・`SOFT_DEADLINE_SECONDS`（12 秒。transcript / rollout を読むのを切り上げる）・`HARD_TIMEOUT_SECONDS`（15 秒。今までどおりの保険で、ここは延ばしていない）。どれもフックの入口（`_entry()`）からの時間。
- **行に要る軽い値（cwd・repo・session・event）は読み取りより前に取ってある**ので、切り上げても行は書ける。重い読み取りは `before_deadline(read)` の中だけで、間に合わなければ `_Deadline` で抜けて**読めた分だけ**で行を書く（値は 1 つずつ代入されるので、途中まで読んだ本文は入らない。前のターンの返答でも埋めない。#467）。
- 結果として **`Stop` の行はあるが `text` が空**になる。行の形は変えていない（フィールドも `RECORD_VERSION` もそのまま）。空の本文を画面がどう見せるかは SAI の側（#614）。
- 行を書くのは `main()` の 1 か所だけなので、1 ターンに `Stop` の行は 1 本。
- `_Deadline` は `BaseException`（読み取りの中の `except Exception` に飲まれない）。アラームを投げるのは `before_deadline()` の中だけで、抜けたら必ず 15 秒の保険に掛け直す（`_arm_hard_guard()`）。
- `repo` は git が**答えなかった**（時間切れ・予算切れ。`_git_gave_up`）ときだけ `toplevel_name()`（実パスに直してから `.git` のあるディレクトリまで上がる。git は起こさない）。git が断ったとき（リポジトリの外・`.git` の中）は今までどおり cwd の名前。cwd の名前に落ちると、下のディレクトリで動くセッションの行が別のエンティティになる。
- **終わるときに保険のタイマーを外す**。Python は終了時にシグナルの受け口を既定に戻すので、後片付けが遅いあいだにアラームが届くと SIGALRM で殺されて非 0 になる。
- `build_row()` を直に呼ぶとき（テスト）は `_STARTED` が無いのでタイマーを掛けない。

### 質問の待ちの行の選択肢（`questions`）

- 質問の待ちの行には選択肢まで載せる（#334。`question_structure()` → 行の `questions`。v9）。キーの名前はフックの `tool_input.questions` と同じ。
- 画面は `web/src/terminalQuestion.ts` の `rowQuestions()` が `askQuestions({ questions })` にそのまま渡し、`Chat` が待ちのバブルに `QuestionPreview` を出す。行にあればそれ、無い古い行は #333 の transcript（`questionsFor()`）に落とす。行から出すので別のマシンのセッションでもフィードでも出る。
- 出すのは #333 と同じく、いまのセッションの待ちがその文のまま（端末で答えて `WaitingSettle` が畳んだら消す）で、SAI で答えられる質問（`answerableIds()`＝答えられる承認か `-p` の返信中）でないときだけ（#518 のレビュー。行の `resolved` は次の行まで立たない）。
- 問・選択肢・文の長さに上限を置き、切ったら `clipped` に `questions`。`text` は変えていない（`shared/approvals.test.ts` と揃えた期待文字列）。

### 本文の上限（`clipped`）

- 本文の上限は `MAX_TEXT` / `MAX_USER_TEXT` / `MAX_THINKING` の 20000 字で、切ったら行の `clipped` に項目名を載せる（#358）。判定は `shared/clipped.ts` の `wasClipped()`（`clipped.test.ts`）。画面は `ClippedNote` を本文の末尾に出す。
- 記録の時点で落とすので後から復元できない（transcript に残るのは Claude / Codex のこのマシンのぶんだけ）。
- 上限そのものは残す（壊れた payload で JSONL を膨らませないため）。

## feed/opencode/sai.js（OpenCode のプラグイン）

- OpenCode のプラグイン（フックの仕組みが無いのでこの形しかない）。`session.idle` でターン完了、`permission.asked` / `permission.replied` で待ちと再開を組み立て、`record.py --agent opencode` に stdin で渡す。置き方は README。
- opencode 本体の中で動くので throw しない（`record.py` が必ず exit 0 なのと同じ理由）。
- 本文はイベントに載らないので、`message.updated`（役割・モデル・cwd）と `message.part.updated`（本文）を覚えておいて `session.idle` で 1 行にする。
- `session.idle` は 1 ターンに複数回鳴ることがある（ターンを止めると同じ秒に 2 回鳴る）ので、本文が増えていなければ流さない。その状態は送る前に空にする（#392。`send()` は record.py の終了を待つので、その間に次の idle が届く）。
- 人が止めたターン（`session.error` の `MessageAbortedError`。SAI の「止める」も TUI の Esc も同じ）で本文が出ていなければ `（本文なし）途中で止めました` を `text` に入れる（途中まで出ていれば本文のまま。#273 の失敗したツールと同じ形）。
- 本文の無いターン（`opencode run` が許可を自動で reject してツールが失敗したまま終わる。SAI の返信経路 `opencode run -s` が必ず当たる）は、最後に失敗したツールのパーツ（`state.status: "error"`）から `（本文なし）read の許可が拒否されて終わりました（…）` を `text` に入れる（#273。行の形は変えないので `RECORD_VERSION` は上げていない）。
- 同じ瞬間の `permission.asked` / `permission.replied` は record.py が競走して逆順に書かれることがあるが、プラグインで直列にしない（後ろの送信が遅れて `opencode run` の終了に巻き込まれ、行が消える）。
- `session.idle` は `opencode run` が終わる直前に鳴るため、`record.py` の終了を待つ（待たないと本体ごと落ちて行が消える）。
- テストは `server/opencodePlugin.test.ts`（偽の `record.py` に payload を書き出させる）。

## Grok Build（xAI の `grok`）

- #325。まず記録と表示だけで、返信は `replyBlockedReason()` が止める。
- `~/.claude/settings.json` のフックも読むので、Claude Code 向けの `record.py` の設定がそのまま Grok でも呼ばれる。
- stdin は camelCase（`hookEventName` = grok の snake_case の名前、`sessionId`、`lastAssistantMessage` …）に Claude 向けの snake_case の別名（`hook_event_name` = Claude の PascalCase の名前、`session_id`、`permission_mode` …）が足されて届くので、`detect_agent()` は `hookEventName` のキーを Claude より先に見る（見ないと Claude として記録され、返信が `claude --resume` に向く）。
- 書くのは `Stop`（本文は `lastAssistantMessage`）・`UserPromptSubmit`（`prompt`）・`Notification`（`notificationType` が待ちの型のときだけ。表は Claude と同じ）で、他のイベントとサブエージェントの中のもの（`subagentType`）は書かない。
- 入力・最初の入力・モデルは `GROK_HOME/sessions/<encodeURIComponent(cwd)>/<session>/chat_history.jsonl`（`find_grok_chat_history()`。255 バイトを超える cwd は slug になるので 1 段探す）の `type: user`（`synthetic_reason` の無いもの）と `type: assistant` の `model_id` から。
- pid は取らない（端末で開いているかは判定しない）。
