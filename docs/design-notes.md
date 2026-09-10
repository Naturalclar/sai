# 先に確かめた前提

いまの作りがこうなっている理由。手元で確かめた結果と、そこから決めたこと。セットアップは [README](../README.md)。

**素朴に作ると動かない点が3つ、期待しすぎると外れる点が1つ、集めても越えられない線が2つある。**

## 1. 「セッション終了」は掴めない

- Claude Code の `SessionEnd` は `/clear` のときしか発火しない
- Codex の `notify` はイベントが `agent-turn-complete` の1種類だけ

→ 共通して掴めるのは「ターン完了」だけなので、Claude 側も `Stop` フックを使う。1行 = 1ターン。セッションは後段でまとめる。

## 2. Codex の notify ペイロードにセッションIDが無い

Claude の `Stop` は `session_id` を stdin の JSON に含むが、Codex の `agent-turn-complete` には無い。

→ **記録時に、cwd が一致する直近の rollout ファイル（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`）からセッションIDを引く。** `session_index.jsonl` は壊れていることがある（`codex resume --all` が「No sessions yet」になる既知の問題）ので、索引ではなくファイル名から直接取る。

それも取れなかったときは `(repo, cwd, agent)` が同じで前の行から**30分以内**なら同じセッションとみなし、ID は `synth-<repo>-<開始時刻>` にする。合成であることが後から分かるよう `session_source` を `synth` にする。一覧では「合成」の印が付く。

もう1つ落とし穴がある。**Codex は人のターンとは別に裏で回す LLM 呼び出し（タスクのタイトル生成、次にやることの提案、安全性チェック）でも `agent-turn-complete` を鳴らす。** これにもセッション ID は無く、rollout にも書かれないので、そのまま記録すると同じ cwd で進行中のセッションに `{"title":"…"}` のような JSON だけの返答が紛れ込む。`record.py` は `input-messages` が既知の内部プロンプトで始まるか、返答が JSON オブジェクトだけで入力に内部プロンプトの決まり文句（`Do not answer the request`）があれば、行を書かない（`is_codex_internal_turn()`）。新しい種類の内部呼び出しが増えると JSON だけのバブルとして現れるので、そのときは接頭辞の一覧（`_CODEX_INTERNAL_PROMPT_PREFIXES`）に足す。

## 3. 「待っている」はターン完了とは別の行で掴む

許可待ち・質問待ち・プランの承認待ちで止まっている間は `Stop` が来ないので、ターン完了だけ記録していると一覧では「最後のターンから動いていない」ようにしか見えない。

→ 止まった瞬間に鳴る `PermissionRequest`（許可）と `PreToolUse`（`AskUserQuestion` / `ExitPlanMode`）で「何を待っているか」を待ちの行として書き、後に `Stop` か `UserPromptSubmit` が来たら解消したとみなす（集計は「最後の行が待ちか」だけを見る）。`Notification` は 6〜60 秒遅れて鳴る補欠。

確かめた範囲で分かっていること:

- `PermissionRequest` には `tool_use_id` が無い（`PreToolUse` にはある）。重複は「同じセッションの直前の行と同じ text」で落とす
- 非対話（`claude -p`。画面からの返信もこれ）で許可が要るツールを呼ぶと、**自動で拒否されて `PermissionRequest` は鳴らない**（Claude Code 2.1.258 で確認）。つまり返信経路で許可待ちに入ることは無く、拒否されたあとの返答が普通のターンとして届く
- **`AskUserQuestion` / `ExitPlanMode` が `-p` に出るかは `--permission-prompt-tool` 次第**（2.1.266 で測り直した。`-p --output-format stream-json --verbose` の最初の `system` 行の `tools` を見る）。素の `-p` では両方とも出ないが、`--permission-prompt-tool` を付けると**どちらも出る**（`--mcp-config` だけでは出ない。効いているのは前者）。SAI の返信は必ず付けている（`SAI_APPROVE=0` のときだけ外れる）ので、**返信中に質問で止まることはある**。答えの `answers` には選択肢の label 以外の文字列（その他の自由記入）を入れてもそのままエージェントに届く（#195）
- `AskUserQuestion` / `ExitPlanMode` で `PermissionRequest` が鳴るかは端末でしか確かめられないので、`PreToolUse` を matcher 付きで並走させている。両方鳴っても同じ text なので1行になる
- Codex の `notify` は `agent-turn-complete` しか無い。tmuxで通常起動したCodexはペインから待機だけ検出し、回答は端末へ案内する。一方、SAIから閉じたセッションへ送るターンはSAI配下の長寿命stdio app-server接続で管理し、server requestを構造化して受ける。既存TUIの所有権を途中で奪わないことを境界にして、writerが生きているthreadは従来どおりtmux/queue、閉じたthreadだけ `thread/resume` / `turn/start` を使う

## 4. transcript に残る思考は短い要約で、ターンの 4 分の 1 程度

Claude Code の transcript には assistant の `thinking` ブロックが書かれるが、手元の 12 本（154 ターン）を数えると **781 個のうち本文があるのは 77 個（10%）** で、残りは `signature` だけ。思考が読めるターンは **35 / 154（23%）**、読めるときも 1 ターン合計で中央値 200 文字、最大 530 文字（Claude Code 2.1.258）。

→ `thinking` は「モデルの推論を全部読める」ものではなく、**あれば出す**。大半のバブルには何も付かない。Codex の rollout の `reasoning` は既定では `summary: []` + `encrypted_content` で何も読めない（`~/.codex/config.toml` の `model_reasoning_summary` で summary が入るかは未確認）。

## 5. リモートの行は見るだけで、返信はそのマシンからしかできない

複数のマシンの JSONL を 1 か所に集められる（[#24](https://github.com/Naturalclar/sai/issues/24)。`AGENT_FEED_HOST` と `YYYY-MM-DD.<host>.jsonl`。手順は [README](../README.md)）が、**集まるのは記録だけ**で、そのセッションを再開する手立ては付いてこない。

- 再開は `claude -p --resume <id>` / `codex exec resume` を **`cwd` で起動する**ことなので、その CLI・その履歴・その worktree があるマシンでしか走らない。行に `session` と `cwd` が載っていても、こちらには同じパスも同じ会話も無い
- 端末に打ち込む経路も同じで、tmux のペインはあちらのマシンにある
- そこで、行の `host` がサーバ自身の名前（記録側と同じ `AGENT_FEED_HOST` か `os.hostname()`。#288）と違えば **`replyBlockedReason()` が止める**。サーバの受付（`400`）・入力欄・フィードの `@` 候補・「要対応」の `replyable` が同じ判定を見る

→ **リモートは「眺める」だけ**。答えるならそのマシンの SAI（か端末）へ行く。「こちらの SAI からあちらの SAI へ転送する」は別の話で、SAI 同士が通信することになるので「SAI は外に出さない」との兼ね合いを先に決める必要がある。

判定は安全側に倒してある。**`host` が空の行**（`host` を載せない古い `record.py`）と、**サーバが自分の名前を決められないとき**は、リモートにしない。材料が無いのに返信を止めると、1 台で使っている人が返信できなくなるため。

## 6. claude.ai/code のクラウドセッションは対象外（フックが鳴らない）

[#116](https://github.com/Naturalclar/sai/issues/116) で調べた（Claude Code 2.1.266、手元の `~/.claude/` と[公式ドキュメント](https://code.claude.com/docs/en/claude-code-on-the-web)）。**クラウドで回っているターンは、このマシンでフックが鳴らない**。SAI の記録は「フックが1行 append する」ことだけで成り立っているので、クラウドセッションは**集められない**。

確かめたこと:

- **クラウドの transcript はローカルに降りてこない。** `~/.claude/projects/` の全 transcript を舐めて、トップレベルのキーに `cloud` / `remote` / `host` に類するものは 1 つも無く、載っている `cwd` はすべてこのマシンに実在するパスだった
- **セッション一覧やトランスクリプトを取る API は無い。** Messages / Batches / Files / Models / Admin API のどれにも口が無い（Admin API は組織の管理だけ。SDK 外の raw HTTP も使用量とコストの集計まで）。**Managed Agents の「セッション」は別物**（API で作るエージェントの実行単位で、claude.ai/code のセッションではない）
- **`--cloud` は送るだけ。** `claude -p "…" --cloud <session-id>` はメッセージを queue に入れて終わり、返るのは `{ok, session_id, url}` だけで本文は取れない
- **`--teleport` は手で引く一方通行。** 「会話の履歴を端末に読み込み」「端末はそのセッションの**自分のコピー**を持つ」（公式ドキュメント）。引いた**後**のターンはローカルなので普通に記録されるが、**クラウド側で回っていた分は遡って行にならない**。しかも作業ツリーが clean で、同じリポジトリで、ブランチが push 済みという条件付きで、対話的に選ぶ操作が要る

**Remote Control（`--remote-control`）は別で、こちらは拾える。** Web やモバイルから操作していても**セッション自体はそのマシンのローカルで動いている**ので、フックは普通に鳴る。手元の transcript には `type: "bridge-session"` の行を持つセッションが 31 あり、そのうち窓の中の 13 について `Stop` / `UserPromptSubmit` / `PermissionRequest` / `PreToolUse` / `Notification` が JSONL に揃っていた（残りは記録を始める前か、フックを向けていないリポジトリのもの）。**別マシンの Remote Control セッションも、そのマシンで記録されるので #24 のファイル同期で集まる。**

→ **クラウドセッションは SAI の対象外**とする。取りに行くならフックではない別経路（teleport した transcript を読む、など）が要るが、それは「1行 append」の作りを変える話なので、必要になったら別の issue で。
