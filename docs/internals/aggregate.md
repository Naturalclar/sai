# 記録と集計の仕組み（行 → セッション）

CLAUDE.md から移した「どう動くか」。守る決まりは CLAUDE.md、経緯は [history/aggregate.md](../history/aggregate.md)。行の形そのものは [data.md](../data.md)。

## エンティティ ID

- `shared/entity.ts` の `entityId()`（`<セッション>@<リポジトリ>`、取れない行は `unknown-<日付>`）を、集計（`aggregate.ts`）・詳細 API の行の絞り込み（`app.ts`）・画面のリンク（`Chat.tsx`）が全部通す。

## セッションの終わり（`SessionEnd`。#385）

- 記録の軸は「ターン完了」の行で、セッションはサーバ側の `aggregate()` でまとめる（Codex の `notify` と OpenCode のプラグインに終了のイベントは無い）。
- Claude Code の `SessionEnd` の `reason`: `/clear` → `clear`、`/exit` → `prompt_input_exit`、`claude -p` が 1 回終わったとき・ペインごと殺したとき（SIGHUP）→ どちらも `other`。
- `record.py` が書くのは人が意図して終えたもの（`clear` / `prompt_input_exit` / `logout`）だけで、`other` は書かない（SAI 自身の返信はすべて `-p` なので、書くと返信のたびに終了の行が増える）。
- `/clear` は古いセッションの終わりとして鳴り、直後に新しいセッション ID で始まる（`SessionStart` の `source` も `clear`）ので、SAI の一覧では別のセッションになる。
- 行は `eventKind()` の `end` で、チャットでは発言ではなく日付と同じ区切り線（`web/src/SessionEndLine.tsx`。`groupRows()` が `divider` の塊にして前後と混ぜない）。
- 終了の行では transcript を読まない（読むと最後のターンの返答がもう 1 行ぶん増えて、同じ発言が 2 回出る）。行の形は変えていないので `RECORD_VERSION` は上げていない。
- A（終わった方）と B（続き）を繋ぐには `SessionStart` も要るが、まだ書いていない。

## Codex の notify にはセッション ID が無い

- `~/.codex/sessions/` の rollout ファイルを cwd で引く（`session_source: rollout`）。引けなければ `(repo, cwd, agent)` が同じで 30 分以内の前行と同じセッションにする（`synth`）。`session_index.jsonl` は壊れていることがあるので索引は使わない。
- resume / queue 後の `input-messages` には過去の入力がすべて並ぶため、`user_text` には末尾の今回分だけを使う（今回分が text block の配列なら、その中は連結する）。
- タイトル生成などの内部の LLM 呼び出しでも notify が鳴る（ID 無し・rollout にも無い）ので、`record.py` の `is_codex_internal_turn()` が中身（既知のプロンプトの書き出し、JSON だけの返答 + `Do not answer the request`）で落とす。
- レビュー（`review/start`。#403）は子スレッドで走り、rollout も別ファイルとして書かれる（`id` は子、`session_meta.session_id` と `parent_thread_id` は親）。どちらのファイルが当たるかは mtime の差で決まるため、`_rollout_session_id()` は `session_meta.session_id`（どちらのファイルでも親）を先に見る（ファイル名の UUID は無いときのフォールバック）。
- レビューの返答は findings の JSON だけで届くので、`codex_review_text()` が読める Markdown に直し、`review/start` が組み立てた英語の指示文は `codex_review_label()` が「差分のレビュー（未コミットの変更）」に置き換える（人が自分で打った指示はそのまま残す）。行の形は変えないので `RECORD_VERSION` は上げない。

## タイトルと 1 つだけ出す値

- `aggregate.ts` の `sessionTitle()` が新しい行から遡って最初の `user_text` の 1 行目を使う（画面から返信しても端末で続きを打っても、次のターンが記録された時点で変わる）。フィードの `@` の候補のラベル（`feedReplyTargets`）も同じ順。`user_text` が 1 行も無いときだけ `first_user_text` に落ちる。
- **`user_text` が自動の要約の文になっている行（#626）は、題名にも `last_user_text` にも数えない**（`shared/compactSummary.ts` の `isCompactSummaryText()`。文の書き出し `This session is being continued from a previous conversation` で見る）。`record.py` は直したが、もう書かれた行には印が無く、記録は書き換えないので読む側で飛ばす。同じ判定を画面の自分のバブル（`chatGroups.ts`）・↑ の履歴（`replyHistory.ts`）・メッセージの返答の引き当て（`deliveryMatcher()`）が使う。
- `first_user_text` は毎行に載る（フォールバックの集計は最古の行の値を使うので、`days` の窓から 1 行目が落ちてもタイトルが残る）。
- `session_source` / `branch` / `host` / `remote` / `project` / `agent` / `repo` は `latestValue()`（値のある一番新しい行。値の無い行では上書きしない。#283）。`session_source` だけは合成（`synth`）が 1 本でもあれば `synth` に倒す（返信できない方）。`agents` / `branches` / `sources` などの一覧は出てきた順のまま。

## 自分の入力（`UserPromptSubmit`）

- `record.py` は Claude の入力のたびに `user_text` だけの行（`event: UserPromptSubmit`、`text` は空）を書き、続く `Stop` の行にも同じ `user_text` が載る。
- Claude Code が差し込む入力（バックグラウンドのタスク完了の `<task-notification>`。transcript では `promptSource: system`）は人の入力ではないので `user_text` にしない（`_is_system_prompt()`）。
- 画面（`web/src/chatGroups.ts`）は同じエンティティで直前の入力行と同じ文なら `Stop` 側の自分バブルを出さない。`turns` と「返信が終わった」の判定は `Stop` の行だけで数える（`eventKind() === 'turn'`）。
- 画面から返信したときの仮バブルは、入力の行が届いたら `promptArrived()` で本文を消して「処理中」の 1 行にする。入力を載せたターン完了の行でも消す（#375。Codex と OpenCode は入力の行を書かず `user_text` がターン完了の行に載る）。

## リポジトリ（`project`）と見出しのリンク

- `repo` は git の toplevel の basename なので、bare clone の worktree（`…/sai.git/dev-min`）では worktree 名になる。絞り込みは `project`（どのリポジトリか）で見る（#163）。
- `record.py` の `git_project()` が `remote` の `owner/repo`、無ければ `--git-common-dir` からリポジトリ名を取って行に載せる。
- `rowProject()`（`shared/project.ts`）は `project` → `remote` だけを見て、分からなければ空を返す（`repo` には落とさない。#182）。
- 空のセッションは `server/git/project.ts` の `ProjectResolver` が cwd で git を読んで埋める（`remote get-url origin` → 無ければ `--git-common-dir`。cwd をキーにキャッシュ）。それでも分からなければ空のままで、絞り込みの候補には出さず、一覧の表示だけ worktree 名に落ちる。
- `resolve()` は `project` と一緒に正規化した origin の URL（`remote`）も返す（#212）。`fillRepo()` は空いているところにしか入れない（行から来た値が正）。
- 見出しのリンク（#212）: `web/src/RepoLink.tsx` が `shared/project.ts` の `repoLink()`（`remote` が無ければ `null`、ホストが `github.com` なら `github: true`）を見て、`GitHubMark` か `RepoMark` と `owner/repo` を出す。`remote` が無ければ何も出さない。出すのは見出しだけ。判定は純粋関数なので `shared/project.test.ts` で回す。

## 返信の失敗と「処理中」の置き場

- `ProcessRunner` は `exit` のコードが 0 以外なら `Replying.failed`（`code` と `reply.log` のそのターンぶんの末尾。`tailFrom()`）を付けて `FAILED_TTL_MS`（2 分）残す。付いている間は `running()` が false、`persist()` も書かない。`revWith()` が `failed.code` を混ぜ、`useReply` が `replyFailureMessage()` で出す（#172）。
- 「処理中の返信」はメモリと `~/.agent-feed/replying.json` の両方。`start` で書き `exit` で消し、起動時に読んで生きている pid の分だけ引き取る（見るたびに `kill(pid, 0)`）。
- 承認（`Approvals`）も `approvals.json` に書き、起動時にまだ生きている返信の子（`replying.json` から引き取った分）のものだけ引き取る（#440。`persistTo()`。答え済みで CLI に渡していないものも残す）。MCP サーバ（`approve-mcp.ts`）は SAI に届かなくても `RECONNECT_MS`（120 秒）まで繋ぎ直す。tailnet からの送信回数（`McpSendLimiter`）も `mcp-sends.json` に残す。
