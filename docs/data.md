# データ

JSONL の1行に何が入るか、画面から付ける表示名・アイコン・アーカイブをどこに持つか。セットアップは [README](../README.md)。

## 受け口は JSONL 1本だけ

```
Claude Code ──[Stop hook]──┐
                           ├──> ~/.agent-feed/YYYY-MM-DD.jsonl ──> SAI
Codex CLI ──[notify]───────┘
```

フックがやるのは1行 append するだけ。集計も表示もしない。記録が壊れても表示が壊れるだけで済むし、表示を作り変えても記録側は触らずに済む。

### 複数のマシンで使うときはファイルを分ける（#113）

`AGENT_FEED_HOST` を設定すると、書き込み先が `YYYY-MM-DD.<host>.jsonl` になる（設定しなければ今までどおり `YYYY-MM-DD.jsonl`）。同期フォルダ（iCloud / Syncthing / rsync）で 1 つの置き場を共有すると、**複数のマシンが同じファイルに追記して片方が捨てられるか競合コピーができる**ため。

```
~/.agent-feed/
  2026-09-09.jsonl        ← AGENT_FEED_HOST 無しのマシン
  2026-09-09.mini.jsonl   ← AGENT_FEED_HOST=mini
  2026-09-09.air.jsonl    ← AGENT_FEED_HOST=air
```

- `<host>` は行の `host` と同じもの（`gethostname()` の短い形か `AGENT_FEED_HOST`）を、`[A-Za-z0-9_-]` 以外を `-` にして使う。`.` は `host` の時点で落ちているので、ファイル名が `日付.host.jsonl` として読めなくなることはない
- **サーバはその日の `YYYY-MM-DD.jsonl` と `YYYY-MM-DD.*.jsonl` を全部読む**（`server/store.ts` の `feedFiles()`）。読む順は日付 → `host` 名（`host` 無しが先）で固定し、行は `ts` で並べ直す。`(mtime, size)` のキャッシュと `rev` はファイルごとなので、別のマシンのファイルが増えたり追記されたりすれば画面のポーリングが拾う
- **記録側は自分のファイルしか読まない**。合成セッション（`synth`）と待ちの重複判定は自分のマシンの続きを見るものなので、同期されてきたファイルは探索の対象外
- 同期の途中で末尾が切れた行は JSON として壊れているので `parseRows()` が落とす。次のポーリングで揃う

## 1行の形

```json
{
  "ts": "2026-09-02T12:45:04+09:00",
  "agent": "claude",
  "repo": "kanban",
  "branch": "20260902",
  "session": "sess-abc",
  "session_source": "payload",
  "cwd": "/home/user/kanban",
  "event": "Stop",
  "text": "背中のメニューを出した。ワンハンドロウ 10kg×10×3。",
  "user_text": "背中のメニューを出して",
  "thinking": "背中は前回ラットプルダウンだったので、今回はロウ系を中心にする",
  "model": "claude-fable-5-1",
  "first_user_text": "背中のメニューを出して"
}
```

| フィールド | |
| --- | --- |
| `remote` | origin の URL を `https://host/owner/repo` に正規化したもの（`record.py` の `normalize_remote()`。ssh の `git@host:o/r.git` も同じ形、認証情報と `.git` は落とす）。origin が無ければ空。画面が一言の中の `#123` をこのリポジトリの issue に向けるのに使う |
| `v` | 記録側の版（`record.py` の `RECORD_VERSION`。`shared/types.ts` にも同じ値があり、ずれると `pnpm test:feed` が止まる）。行の形を変えるたびに上げる。無い行は試作か古い `record.py` が書いたもの（1 扱い） |
| `agent` | `claude` / `codex` / `opencode` / `unknown`。payload の形で当てるが、`record.py --agent <名前>` と名乗られていればそれ（OpenCode のプラグインはこちら） |
| `repo` | `git rev-parse --show-toplevel` の basename。bare + worktree の構成では worktree のディレクトリ名（`dev-kanade` など）になり、GitHub のリポジトリ名とは限らない。画面では「worktree」と呼ぶ（同じリポジトリに複数あるときだけ絞り込みに出る）。エンティティID（`<セッション>@<リポジトリ>`）はこれで作るので、値は変えない |
| `project` | **どのリポジトリのものか**（`Naturalclar/sai`）。`remote` があればその `owner/repo`、無ければ `git rev-parse --git-common-dir` から取ったリポジトリ名だけ（bare なら `…/sai.git` → `sai`、普通の clone なら `<toplevel>/.git` → その親、のどちらでも同じ答えになる）。画面の絞り込みと見出しはこれを使う。無い行（古い `record.py`）はサーバが `remote` から補い、それも無ければ **`cwd` で git を読んで埋める**（`server/project.ts`。cwd ごとに 1 回だけ）。**それでも分からなければ空**で、絞り込みの候補には出さない（`repo` = worktree 名には落とさない。#182） |
| `session_source` | `payload`（ペイロードから）/ `rollout`（Codex のファイルから）/ `synth`（時間で合成）。一覧の信頼度がここで分かる |
| `event` | 何の行か。ターン完了は `Stop`（Claude）/ `agent-turn-complete`（Codex）/ `session.idle`（OpenCode）。人を待って止まった行は `PermissionRequest` / `PreToolUse` / `Notification` / `permission.asked`（OpenCode）、人が答えて再開した行は `UserPromptSubmit` / `permission.replied`（OpenCode）。読み方は `shared/events.ts` の `eventKind()` にまとめてあり、集計と画面が同じ判定を使う。**ここに挙がっていない値（`SubagentStop`、Codex の `session-configured` など）は `other` で、ターンにも数えず画面にも出さない**（#235）。`hook_event_name` も `type` も無いペイロードでは `unknown` になり、これはターン完了として扱う |
| `text` | ターン完了なら最後のアシスタント発話。Claude は `transcript_path` の末尾から、Codex は `last-assistant-message`。2,000文字で切る。待ちの行なら「何を待っているか」（300文字）、再開の行は空 |
| `user_text` | そのターンの入力（人が打った文）。Claude の `UserPromptSubmit` の行はペイロードの `prompt` そのもの。`Stop` の行は `transcript_path` を末尾から遡って最後の入力（ツールの戻りや差し込みは飛ばす。スラッシュコマンドは `/foo 引数` に戻す。バックグラウンドのタスク完了の通知 `<task-notification>`（`promptSource: system`）で始まったターンは人の入力が無いので空）、Codex は `input-messages` の末尾（resume/queue 後は過去の入力も含まれるため）。画面2で自分側のバブルになり、一番新しい行のものが一覧のタイトルになる。2,000文字で切る |
| `thinking` | そのターンの思考。Claude は `transcript_path` の最後のターン（最後の入力より後）の `thinking` ブロックの本文を `\n\n` で繋いだもの（`signature` だけのブロックは飛ばす）、Codex は rollout の最後のターンの `reasoning` の `summary[].text`。**無いことが多い**（[design-notes.md](design-notes.md) の 4）。ターン完了の行だけ。4,000文字で切る（先頭側を残す）。画面2のエージェントのバブルに折りたたんで出す。`GET /api/feed` の行からは落とす |
| `model` | そのターンを回したモデル。Claude は `transcript_path` の最後の assistant 行の `message.model`（`claude-fable-5-1` など。CLI が合成した `<synthetic>` は飛ばす）、Codex は rollout の最後の `turn_context.model`（`gpt-5.6-sol` など）。ターン完了の行だけ。画面2の見出しに出す |
| `host` | どのマシンで記録したか（#112）。`AGENT_FEED_HOST` があればそれ、無ければ `gethostname()` の短い形（`mbp.local` → `mbp`）。**複数のマシンの JSONL を 1 か所に集めたとき**（[#24](https://github.com/Naturalclar/sai/issues/24)）に行の出どころを分けるためのもので、1 台で使う分には見えない。合成セッション（`synth`）のまとめ方もこれで割るので、別のマシンの同じ `repo` / `cwd` の行が 30 分以内に来ても同じセッションにはならない |
| `pane` / `pid` | セッションが開いている tmux のペイン（`%12`。フックが受け取る `TMUX_PANE`）と本体の pid（Claude は `CLAUDE_PID`、Codex は notify の親）。SAI の返信をそのペインに打ち込むのに使う。tmux の外なら `pane` は空。**SAI が起動したターン（`claude -p` など）でも空**（サーバが子に `TMUX_PANE` を渡さない。#234）|
| `permission_mode` | そのターンの許可モード（Claude のフックの `permission_mode`。`default` / `acceptEdits` / `plan` / `auto` / `dontAsk` / `bypassPermissions`）。Codex には無い。一番新しい行の値が一覧とチャット見出しの印になる |
| `first_user_text` | 最初のユーザー発話。`user_text` が1行も無い古いセッションのタイトルに使う。300文字で切る |

日付は `Asia/Tokyo` で切る。

Codex TUI の質問・許可待ちは `notify` から取れないため、JSONL の行にはしない。サーバの `CodexDialogs` が tmux ペインを確認し、ダイアログ中だけ API の `approvals` に `agent: codex`, `answerable: false` の検出専用項目を足す。ペイン、pid、ダイアログのいずれかが確認できなくなれば消える一時状態で、履歴には残らない。

SAIから開始したCodex turnの待機もJSONLにはせず、`CodexAppServer` のメモリに持つ。`Approval.decisions` は画面用の不透明なid・ラベル・allow/deny表示だけで、app-serverへ返すdecision本体とJSON-RPC request idはブラウザへ出さない。回答、`serverRequest/resolved`、turn完了、切断のいずれかで消える。

`first_user_text` は1行目だけでなく**毎行**に載せている。集計は「一番古い行の値」を使うので結果は同じで、`days` で切った窓の外にセッションの1行目が落ちてもタイトルが消えない。

## セッションの表示名とアイコン

一覧の名前は入力（`user_text` / `first_user_text`）から自動で作るが、ブラウザから自分で付けた表示名と、手元の画像ファイルのアイコンで上書きできる（チャット見出しのアイコンボタン。鉛筆が「名前を付ける / 名前を変える」、写真が「画像を選ぶ / 画像を変える」、ゴミ箱が「画像を消す」。文字は出さないが、ホバーと読み上げでは同じ文言が出る。名前を消すのは入力欄を空にして保存）。付けると、一覧とチャット見出しのほかに、**チャットのエージェント側のバブルの発言者名とアバター**もそれになる（無ければ「Claude Code」/「Codex CLI」と頭文字）。フィードでも同じで、サイドバーの一覧に載っているセッションの分は反映される（一覧の日数の窓に無いセッションは固定の名前に落ちる）。自分側の「あなた」は変わらない。

表示名は JSONL ではなく `~/.agent-feed/session-meta.json` に持つ。

```json
{ "sess-abc@kanban": { "name": "背中メニュー", "persona": "ISTJ" } }
```

キーはエンティティID（`<セッション>@<リポジトリ>`）。記録側（`record.py`）はこのファイルを知らないし、集計（`aggregate()`）も触らない。サーバが応答を返すときに載せるだけなので、消しても履歴は壊れない。

写真のボタン（「画像を選ぶ」）でファイルを選ぶと**加工のモーダル**が開き、正方形の枠に対してドラッグで位置、ホイールかスライダで大きさを決めて「これにする」を押すと、**256px 四方・角丸（一辺の 20%）の PNG** にしてから置く。元のファイルは送らない（ブラウザの Canvas で加工する。サーバ側に画像処理は無い）。選べるファイルは 20MB まで（`ICON_SOURCE_MAX_BYTES`）、置く加工後の PNG は 1MB まで（`ICON_MAX_BYTES`）。GIF はアニメーションが止まる（1 フレーム目）。画面の角丸 CSS も同じ 20% なので、加工前に置いた古い画像も同じ見た目で出る。

アイコン画像は `~/.agent-feed/session-icons/<sha1(ID) の先頭16桁>.<png|jpeg|gif|webp>` にファイルで置く（`session-meta.json` には書かない。ファイルの有無が正）。PNG / JPEG / GIF / WebP で 1MB まで（画面から置くものは加工後の PNG。API を直接叩けば他の種類も置ける）。種類はファイルの中身（先頭のバイト列）で見るので、拡張子だけ画像のファイルは置けない（SVG も受けない）。一覧の各セッションには `icon`（`/api/sessions/<id>/icon?v=<mtime>`）として URL が載り、差し替えると `v` が変わってブラウザのキャッシュを引かない。画像を置いた・消しただけでも一覧の `rev` が変わるので、開いている画面にそのまま反映される。昔の絵文字のアイコン（`icon` キー）は読むときに捨てる。

## 自分の表示名とアイコン

チャットの自分側のバブルは既定では「あなた」（名前）と「私」（アバター）。**ヘッダー右端の自分のアイコン**を押すとメニューが開き、「表示名とアイコン」で名前と画像を付けられる。付けると、過去の行も送信中の仮バブルも、その名前とアバターになる。SAI は1人のローカルの道具なのでプロフィールは1つ。

表示名は `~/.agent-feed/profile.json`（`{ "name": "Jesse" }`）、アイコンはセッションのアイコンと同じ `~/.agent-feed/session-icons/` に固定の鍵 `me` で置く（エンティティ ID には必ず `@` が入るので衝突しない）。画像の加工（正方形・角丸の PNG）もセッションのアイコンと同じモーダルを通す。記録側（`record.py`）も集計も触らず、サーバが応答の `profile` に載せるだけ。名前や画像を変えると `rev` が変わるので、開いている別のタブにもポーリングで反映される。

## アーカイブ

終わったセッションは**アーカイブ**して一覧とフィードから隠せる（Slack のチャンネルのアーカイブと同じで、消すのではなく既定では見えなくする）。これも同じ `session-meta.json` に `archived_at`（アーカイブした時刻、ISO）として持つ。

```json
{ "sess-abc@kanban": { "name": "背中メニュー", "archived_at": "2026-09-02T07:40:00.000Z" } }
```

「アーカイブ済みか」は `archived: true` のような印ではなく、サーバが応答時に **`archived_at >= そのセッションの最後の行の ts`** で決める。アーカイブしたあとに端末でそのセッションを続けると最後の行が `archived_at` を追い越すので、メタを書き換えずに自動で一覧に戻る。「戻す」は `archived_at` を消すだけ。`synth`（時間で合成した ID）のセッションは集計の切れ方で付け先がずれるのでアーカイブできない。

## 履歴はリポジトリに入れない

`~/.agent-feed/` はリポジトリの外。作業内容の断片が入るので、うっかりコミットされない場所に置く。`.gitignore` の `*.jsonl` / `.agent-feed/` / `sessions/` は、手元にコピーしたときの保険として最初のコミットから入っている。
