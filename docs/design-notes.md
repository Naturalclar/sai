# 先に確かめた前提

いまの作りがこうなっている理由。手元で確かめた結果と、そこから決めたこと。セットアップは [README](../README.md)。

**素朴に作ると動かない点が3つと、期待しすぎると外れる点が1つある。**

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
- Codex の `notify` は `agent-turn-complete` しか無いので、Codex の承認待ちは記録できない。tmux で開いている Codex は、サーバが画面ポーリング時にペインを確認してダイアログ中なら一時的な待機表示を足す（JSONL には書かない）。通常起動の TUI には構造化された質問・回答の接続が無いため、SAI からは答えず端末へ案内する。構造化して答えるには Codex の起動・resume を app-server 管理へ移す別設計が必要

## 4. transcript に残る思考は短い要約で、ターンの 4 分の 1 程度

Claude Code の transcript には assistant の `thinking` ブロックが書かれるが、手元の 12 本（154 ターン）を数えると **781 個のうち本文があるのは 77 個（10%）** で、残りは `signature` だけ。思考が読めるターンは **35 / 154（23%）**、読めるときも 1 ターン合計で中央値 200 文字、最大 530 文字（Claude Code 2.1.258）。

→ `thinking` は「モデルの推論を全部読める」ものではなく、**あれば出す**。大半のバブルには何も付かない。Codex の rollout の `reasoning` は既定では `summary: []` + `encrypted_content` で何も読めない（`~/.codex/config.toml` の `model_reasoning_summary` で summary が入るかは未確認）。
