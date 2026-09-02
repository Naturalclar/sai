# SAI — 複数 AI エージェントを跨いだチャット風インターフェース

Claude Code と Codex CLI のターン完了をフックで1本の流れに集めて、**左にセッション一覧、右にチャット**の1画面で眺める。「さっきのあれ、どのセッションでやったんだっけ」を、端末のスクロールバックではなく画面で引けるようにするためのもの。

名前は『ヒカルの碁』の藤原佐為から。自分とは別の打ち手の声が自分の側にいる存在で、打たれた碁を全部見ている。

| | |
| --- | --- |
| **SAI** | 見る側。セッション一覧と会話画面。`web/` |
| **agent-feed** | 集める側。フックが1行ずつ JSONL に追記する配管。`feed/` |

配管（何をどう記録するか）と見え方（どう並べるか）は別々に作り替わるので、名前も分けてある。置き場はこのリポジトリ1つ。履歴（JSONL）は `.gitignore` で外してあるので、実装だけが載る。

```
sai/
├── package.json         … pnpm。画面とサーバをまとめて扱う。lint は oxlint
├── feed/
│   ├── record.py        … フックから呼ばれて1行 append する（Python）
│   └── test_record.py
├── shared/
│   ├── types.ts         … 1行の形と API の形。サーバと画面が両方 import する
│   └── entity.ts        … エンティティID（(セッション, リポジトリ) の組）の作り方
├── server/              … 127.0.0.1 専用の HTTP サーバ（TypeScript / Node）。集計と API、dist/ の配信
│   ├── main.ts          … 入口。引数と bind 先のチェック
│   ├── app.ts           … ルーティング
│   ├── store.ts         … 日付ファイルの読み込みと (mtime, size) キャッシュ
│   ├── aggregate.ts     … 行 → セッションの集計
│   └── *.test.ts        … node:test
└── web/
    ├── src/             … 画面（React + TypeScript）
    ├── vite.config.ts
    └── dist/            … `pnpm build` の成果物（コミットしない）
```

**フックだけ Python**（3.9+ 標準ライブラリのみ）。毎ターン、エージェントの子プロセスとして PATH が最小の環境で呼ばれうるので、`node` が見つからず黙って止まるリスクを避けるため。サーバと画面は pnpm + TypeScript で、サーバは Node 22.18+ の型剥がしで `.ts` を直接動かす（ビルド不要）。

## 使い方

### 1. フックを向ける

**Claude Code** — `~/.claude/settings.json`（全リポジトリ）か `.claude/settings.json`（そのリポジトリだけ）に。`record.py` の場所は `env` の `SAI_HOME` に1回だけ書き、各フックはそれを参照する:

```json
{
  "env": { "SAI_HOME": "/path/to/sai" },
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "python3 \"$SAI_HOME/feed/record.py\" || true" } ] }
    ],
    "PermissionRequest": [
      { "hooks": [ { "type": "command", "command": "python3 \"$SAI_HOME/feed/record.py\" || true" } ] }
    ],
    "PreToolUse": [
      { "matcher": "AskUserQuestion|ExitPlanMode", "hooks": [ { "type": "command", "command": "python3 \"$SAI_HOME/feed/record.py\" || true" } ] }
    ],
    "Notification": [
      { "matcher": "idle_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog|permission_prompt", "hooks": [ { "type": "command", "command": "python3 \"$SAI_HOME/feed/record.py\" || true" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "python3 \"$SAI_HOME/feed/record.py\" || true" } ] }
    ]
  }
}
```

- `env` の値はセッションとそのサブプロセスに渡るので、フックのコマンドからも `$SAI_HOME` で見える。フックのコマンドはシェル（`sh -c`）で動くので変数はそのまま展開される。シェルの rc で `export SAI_HOME=...` しておいても同じ
- `|| true` は保険。`SAI_HOME` が未設定・間違いだと `python3` がファイルを見つけられず exit 2 になり、`Stop` フックの exit 2 は「Claude を止めない」の意味なので、付けないとターンが終われなくなる。`record.py` 自身は常に exit 0 なので、これで潰れるのはパスの間違いだけ

`Stop` だけでもターンは記録される。`UserPromptSubmit` は入力した瞬間に自分の入力をチャットに出すためのもの。残りは**人を待って止まったとき**に「何を待っているか」を出すためのもの:

| フック | いつ鳴るか | 行にするもの |
| --- | --- | --- |
| `PermissionRequest` | ツール実行の許可ダイアログが出た瞬間 | `許可待ち: Bash: rm -rf node_modules` のように、ツール名と入力の要約 |
| `PreToolUse`（`AskUserQuestion` / `ExitPlanMode` だけ） | 質問・プランの承認を求めた | `質問: どのフレームワーク?` / `プランの承認待ち: <先頭3行>`。他のツールで鳴っても何も書かない |
| `Notification` | 入力待ちなどが 6〜60 秒続いた | `入力待ち` など型ごとの日本語。`permission_prompt` は直前が許可待ちの行なら重ねない。`auth_success` や `agent_completed` のような待ちでない型は書かない |
| `UserPromptSubmit` | 人が入力した | `user_text` に打った文をそのまま載せた行（本文 `text` は無い）。ターン完了を待たずに自分側のバブルが出る。直前が待ちの行なら、その解消の合図にもなる。入力が取れなかったときは待ちの直後だけ合図として書く |

`record.py` は待ちのフックで **stdout に何も出さない**（`decision` を出すと許可の判断そのものに触ってしまう）。許可するかどうかはいつも通り端末で答える。

**Codex CLI** — `~/.codex/config.toml` に:

```toml
notify = ["python3", "/absolute/path/to/sai/feed/record.py"]
```

こちらは絶対パスで。`notify` は引数の配列をそのまま実行する（シェルを通らない）ので、`$SAI_HOME` のような変数は展開されない。`notify` の JSON が「最後の引数」で来るか stdin で来るかは資料によって食い違うので、`record.py` は両方受ける。

### 2. 画面をビルドしてサーバを立てる

```
pnpm install && pnpm build
pnpm start                                   # http://127.0.0.1:8787/
pnpm start --port 9000 --feed-dir ~/.agent-feed   # pnpm 10 は「--」もそのまま渡すが、先頭の「--」は落とすので付けてもよい
```

サーバは `web/dist/` を配る。未ビルドなら `/` にその旨が出る。`file://` で開くと fetch が CORS で止まるので、必ずこのサーバ経由で開く。`127.0.0.1` 以外には bind を拒否する。

画面を触るときはサーバを立てたまま `pnpm dev`。Vite が `/api` を `127.0.0.1:8787` に流す。

`main` を取り込んだときは、サーバを止めずに別のターミナルで `git pull && pnpm build` するだけでいい。サーバは `web/dist/` を毎回ディスクから読み、`/api/*` の応答に `X-SAI-Build`（`dist/index.html` の更新時刻）を付けるので、開いているブラウザは 3 秒以内に自分でリロードする。`server/` や `shared/` が変わったときの再起動まで任せたければ `pnpm start:watch`（`node --watch`）で立てる。

```
pnpm lint        # oxlint（web/src, server, shared）
pnpm typecheck   # tsc（web と server の両方）
pnpm test        # node:test（server/、shared/、web/src/）
pnpm test:feed   # python3 -m unittest（feed/）
pnpm build       # typecheck してから vite build
pnpm start:watch # server/ shared/ が変わったら自動で再起動（node --watch）
```

### 3. 確かめる

- Claude で1ターン回す → `~/.agent-feed/YYYY-MM-DD.jsonl` が1行増え、`session_source` が `payload`
- Codex で1ターン回す → 1行増え、`session_source` が `rollout`（`synth` になるなら下の「Codex のセッションID」を疑う）
- `echo 'not json at all' | python3 feed/record.py; echo $?` → `0` で、行は増えない

テスト:

```
pnpm test && pnpm test:feed && pnpm lint && pnpm typecheck
```

同じ一式（＋ `pnpm build`）を GitHub Actions でも回す（`.github/workflows/ci.yml`）。`main` への push と PR が対象で、Node は 22 系の最新、Python は 3.9 と最新の両方。

## データ

### 受け口は JSONL 1本だけ

```
Claude Code ──[Stop hook]──┐
                           ├──> ~/.agent-feed/YYYY-MM-DD.jsonl ──> SAI
Codex CLI ──[notify]───────┘
```

フックがやるのは1行 append するだけ。集計も表示もしない。記録が壊れても表示が壊れるだけで済むし、表示を作り変えても記録側は触らずに済む。

### 1行の形

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
  "first_user_text": "背中のメニューを出して"
}
```

| フィールド | |
| --- | --- |
| `agent` | `claude` / `codex` / `unknown` |
| `session_source` | `payload`（ペイロードから）/ `rollout`（Codex のファイルから）/ `synth`（時間で合成）。一覧の信頼度がここで分かる |
| `event` | 何の行か。ターン完了は `Stop`（Claude）/ `agent-turn-complete`（Codex）。人を待って止まった行は `PermissionRequest` / `PreToolUse` / `Notification`、人が答えて再開した行は `UserPromptSubmit`。読み方は `shared/events.ts` の `eventKind()` にまとめてあり、集計と画面が同じ判定を使う |
| `text` | ターン完了なら最後のアシスタント発話。Claude は `transcript_path` の末尾から、Codex は `last-assistant-message`。2,000文字で切る。待ちの行なら「何を待っているか」（300文字）、再開の行は空 |
| `user_text` | そのターンの入力（人が打った文）。Claude の `UserPromptSubmit` の行はペイロードの `prompt` そのもの。`Stop` の行は `transcript_path` を末尾から遡って最後の入力（ツールの戻りや差し込みは飛ばす。スラッシュコマンドは `/foo 引数` に戻す）、Codex は `input-messages`。画面2で自分側のバブルになり、一番新しい行のものが一覧のタイトルになる。2,000文字で切る |
| `first_user_text` | 最初のユーザー発話。`user_text` が1行も無い古いセッションのタイトルに使う。300文字で切る |

日付は `Asia/Tokyo` で切る。

`first_user_text` は1行目だけでなく**毎行**に載せている。集計は「一番古い行の値」を使うので結果は同じで、`days` で切った窓の外にセッションの1行目が落ちてもタイトルが消えない。

### セッションの表示名とアイコン

一覧の名前は入力（`user_text` / `first_user_text`）から自動で作るが、ブラウザから自分で付けた表示名と絵文字のアイコンで上書きできる（チャット見出しの「名前を付ける」）。付けると、一覧とチャット見出しのほかに、**チャットのエージェント側のバブルの発言者名とアバター**もそれになる（無ければ「Claude Code」/「Codex CLI」と頭文字）。フィードでも同じで、サイドバーの一覧に載っているセッションの分は反映される（一覧の日数の窓に無いセッションは固定の名前に落ちる）。自分側の「あなた」は変わらない。これは JSONL ではなく `~/.agent-feed/session-meta.json` に持つ。

```json
{ "sess-abc@kanban": { "name": "背中メニュー", "icon": "🏋️" } }
```

キーはエンティティID（`<セッション>@<リポジトリ>`）。記録側（`record.py`）はこのファイルを知らないし、集計（`aggregate()`）も触らない。サーバが応答を返すときに載せるだけなので、消しても履歴は壊れない。

### アーカイブ

終わったセッションは**アーカイブ**して一覧とフィードから隠せる（Slack のチャンネルのアーカイブと同じで、消すのではなく既定では見えなくする）。これも同じ `session-meta.json` に `archived_at`（アーカイブした時刻、ISO）として持つ。

```json
{ "sess-abc@kanban": { "name": "背中メニュー", "archived_at": "2026-09-02T07:40:00.000Z" } }
```

「アーカイブ済みか」は `archived: true` のような印ではなく、サーバが応答時に **`archived_at >= そのセッションの最後の行の ts`** で決める。アーカイブしたあとに端末でそのセッションを続けると最後の行が `archived_at` を追い越すので、メタを書き換えずに自動で一覧に戻る。「戻す」は `archived_at` を消すだけ。`synth`（時間で合成した ID）のセッションは集計の切れ方で付け先がずれるのでアーカイブできない。

### 履歴はリポジトリに入れない

`~/.agent-feed/` はリポジトリの外。作業内容の断片が入るので、うっかりコミットされない場所に置く。`.gitignore` の `*.jsonl` / `.agent-feed/` / `sessions/` は、手元にコピーしたときの保険として最初のコミットから入っている。

## 先に確かめた前提

**素朴に作ると動かない点が3つある。**

### 1. 「セッション終了」は掴めない

- Claude Code の `SessionEnd` は `/clear` のときしか発火しない
- Codex の `notify` はイベントが `agent-turn-complete` の1種類だけ

→ 共通して掴めるのは「ターン完了」だけなので、Claude 側も `Stop` フックを使う。1行 = 1ターン。セッションは後段でまとめる。

### 2. Codex の notify ペイロードにセッションIDが無い

Claude の `Stop` は `session_id` を stdin の JSON に含むが、Codex の `agent-turn-complete` には無い。

→ **記録時に、cwd が一致する直近の rollout ファイル（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`）からセッションIDを引く。** `session_index.jsonl` は壊れていることがある（`codex resume --all` が「No sessions yet」になる既知の問題）ので、索引ではなくファイル名から直接取る。

それも取れなかったときは `(repo, cwd, agent)` が同じで前の行から**30分以内**なら同じセッションとみなし、ID は `synth-<repo>-<開始時刻>` にする。合成であることが後から分かるよう `session_source` を `synth` にする。一覧では「合成」の印が付く。

### 3. 「待っている」はターン完了とは別の行で掴む

許可待ち・質問待ち・プランの承認待ちで止まっている間は `Stop` が来ないので、ターン完了だけ記録していると一覧では「最後のターンから動いていない」ようにしか見えない。

→ 止まった瞬間に鳴る `PermissionRequest`（許可）と `PreToolUse`（`AskUserQuestion` / `ExitPlanMode`）で「何を待っているか」を待ちの行として書き、後に `Stop` か `UserPromptSubmit` が来たら解消したとみなす（集計は「最後の行が待ちか」だけを見る）。`Notification` は 6〜60 秒遅れて鳴る補欠。

確かめた範囲で分かっていること:

- `PermissionRequest` には `tool_use_id` が無い（`PreToolUse` にはある）。重複は「同じセッションの直前の行と同じ text」で落とす
- 非対話（`claude -p`。画面からの返信もこれ）で許可が要るツールを呼ぶと、**自動で拒否されて `PermissionRequest` は鳴らない**（Claude Code 2.1.258 で確認）。`AskUserQuestion` は `-p` ではそもそもツールとして出ない。つまり返信経路で許可待ちに入ることは無く、拒否されたあとの返答が普通のターンとして届く
- `AskUserQuestion` / `ExitPlanMode` で `PermissionRequest` が鳴るかは端末でしか確かめられないので、`PreToolUse` を matcher 付きで並走させている。両方鳴っても同じ text なので1行になる
- Codex の `notify` は `agent-turn-complete` しか無いので、Codex の承認待ちは記録できない

## SAI（画面）

### 1画面: 左にセッション一覧、右にチャット

Slack と同じ形。左のサイドバーがチャンネル一覧（先頭に固定の「フィード」、その下にセッション）、右がチャット。URL は hash で、`#/` と `#/feed` がフィード、`#/s/<id>` が選んだセッション。横幅 900px 未満では一覧かチャットのどちらかだけになり（`#/` が一覧、`#/feed` と `#/s/<id>` がチャット）、チャット側に「← 一覧」が出る。

キーボードでも動ける。`↑` / `↓`（vim 風に `k` / `j` でも）で、**いま開いているセッションを起点に**サイドバーの並びのまま隣のセッションへ移り、右のチャットも変わる（選んだ項目が見えるようにサイドバーがスクロールする）。開いているセッションが一覧に無いとき（フィードを見ている、絞り込みで隠れている）は先頭へ。端では止まる。`Esc` でフィードに戻る。入力欄にフォーカスがある間はそちらの操作（caret の移動、`@` の候補）なので効かない。サイドバーを閉じていても効く。

サイドバーはヘッダ左端の「≡」か `⌘\` / `Ctrl+\` で折りたためる（閉じた状態は localStorage に残る。開閉は 0.2 秒で滑らかに動き、OS で「視差効果を減らす」にしていれば即座に切り替わる）。閉じている間はチャット側に「← 一覧」が出て、押すとページは変えずにサイドバーが開く。狭い画面ではこの開閉は効かない（一覧かチャットのどちらかだけ、のまま）。

サイドバーの1項目 = 1エンティティ = **(セッション, リポジトリ)** の組。新しい順。同じセッションIDが別リポジトリに現れても（IDの衝突や cwd の移動）、リポジトリごとに別の項目になる。IDは `<セッション>@<リポジトリ>`。

| 出すもの | 出どころ |
| --- | --- |
| リポジトリ / ブランチ | `repo` / `branch`。ブランチが途中で変わったら最後の値を出して「+N」。先頭の色の点が `agent` |
| 最終更新 · ターン数 | 最後の `ts` と、ターン完了の行数（待ち・再開の行は数えない） |
| タイトル | 一番新しい `user_text` の1行目。画面から返信しても端末で続きの指示を打っても、次のターンが記録された時点で最後の入力に変わる。`user_text` が無ければ `first_user_text`、それも無ければ最初の `text` の1行目。60文字で切る |
| 最後の発言 | 最後の `text` の1行目（Markdown の記号は落とす） |
| 印 | `session_source` が `synth` なら「合成」。最後の行が待ちの行（`waiting`）なら「待機中」（マウスを乗せると何を待っているか）。画面からの返信を処理中なら「返信中」。アーカイブ済みなら「アーカイブ」（「アーカイブ済みを見る」のときだけ出る） |

絞り込み（リポジトリ / エージェント / 日付 / 日数）はサイドバーの上。「アーカイブ済みを見る」を押すとアーカイブ済みのセッションだけが薄く出る（既定では出ない）。項目にマウスを載せる（かフォーカスする）と右上に「アーカイブ」が出て、セッションを開かずにその場でアーカイブできる（「アーカイブ済みを見る」中は「戻す」）。フィードのリポジトリはここで選んだものに従う（同じ画面に「リポジトリ」を2つ出さない）。フィードの日数だけはチャット側の右上で選ぶ。

### チャット

Slack のチャット風。1ターンは「自分の入力（`user_text`）→ エージェントの返答（`text`）」の2つのバブルで出るので、往復で読める。Claude は入力した瞬間に `UserPromptSubmit` の行が先に届くので、自分のバブルはターン完了を待たずに出る（続く `Stop` の行に載っている同じ入力は重ねない）。同じ発言者の連続した発言（10分以内）は Slack と同じくまとめる。人を待って止まった行（`PermissionRequest` など）は `⏳ 許可待ち: Bash: rm -rf node_modules` のような**待ちのバブル**になり、後にターン完了か再開の行が来ていれば薄く残る。再開の行（`UserPromptSubmit`）は本文が無いのでバブルにしない。リポジトリ名がチャンネル。自分のバブルは Markdown にせずそのまま出す。3秒ごとに更新するが、サーバが返す `rev` が変わっていなければ state を触らない（= 描き直さない）。タブが隠れている間は止まる。

バブルの本文は **Markdown として描く**（`shared/markdown.ts` → `web/src/Markdown.tsx`）。扱うのはエージェントの返答で頻出するものだけ: URL と `[ラベル](URL)` のリンク（別タブで開く。先が http(s) 以外ならリンクにしない）、`**太字**`、`` `コード` ``、`- ` / `1. ` の箇条書き、`#` 見出し、` ``` ` のコードブロック、`> ` 引用、`---` 罫線。それ以外はそのまま改行を保って出す。HTML 文字列は組み立てず React 要素にするので、`text` に HTML が入っていてもただの文字として出る。一覧の「最後の発言」は同じ字句解析で記号だけ落とした1行。

チャット見出しの「アーカイブ」でそのセッションを一覧とフィードから隠せる（アーカイブ済みなら「戻す」）。アーカイブ済みのセッションは `#/s/<id>` で直接開けば普通に読めるが、入力欄は出ない（返すなら先に戻す）。

セッションを開いているときは、下の入力欄から**そのセッションに続きの指示を送れる**（Enter で送信、Shift+Enter で改行）。サーバが `cwd` でセッションを非対話モードの CLI で再開して1ターン回す:

| エージェント | コマンド |
| --- | --- |
| Claude Code | `claude -p --resume <session> -- "<text>"` |
| Codex CLI | `codex exec resume <session> -- "<text>"` |

`--` は本文が `-` で始まっても（`-v` や `--help`）CLI のフラグとして解釈されないようにするため。

回したターンが完了すれば既存のフック（Stop / notify）が動いて JSONL に1行増えるので、返信の結果は今のポーリングでそのまま画面に流れてくる。送信直後は「送信中…」の仮バブルが出て、`UserPromptSubmit` の行が届けば本文はそちらの本物のバブルに置き換わり「処理中」の1行だけ残る。行が増えたら消える（増えた行の `user_text` が同じ文なので、見た目はそのまま本物の自分のバブルに変わる）。

**送った返信と返答は、そのセッションを開いている端末や Desktop の画面には出ない。** SAI には出るし履歴にも残るが、開いている対話側は会話をメモリに持っていて、外で回ったターンを読み直さない。入力欄の下にもこの注意を出している。確かめたこと（Claude Code 2.1.258 / Codex CLI 0.139）:

- `claude -p --resume <session>` は同じセッションのトランスクリプト（`~/.claude/projects/<project>/<session>.jsonl`）に**追記する**。セッション ID も同じで、別セッションには分岐しない（`--fork-session` を付けたときだけ分岐する）
- `codex exec resume <session>` も同じ rollout ファイル（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`）に追記する。新しい rollout は作らない
- なので、端末を閉じて `claude --resume <session>`（Codex は `codex resume <session>`）で**開き直せば**、SAI から送った返信とその返答も履歴に並ぶ
- 開いたままの端末で続きを打つと、その端末は SAI のターンを知らないまま進む。Claude Code の資料も「同じセッションを2つの端末で再開すると、両方のメッセージが1つのトランスクリプトに交互に入る」としている（[Manage sessions](https://code.claude.com/docs/en/sessions)）。壊れはしないが、対話側のエージェントは SAI で頼んだことを覚えていない
- Claude Desktop は CLI と「別のセッション履歴」を持つ（[Desktop の資料](https://code.claude.com/docs/en/desktop)）。`settings.json` は共有なのでフックは動いて SAI には出るが、Desktop のセッションを `claude -p --resume` で再開できるか、Desktop の画面に出るかは未確認（この Mac に Desktop が無い）

対話側にも出したいなら、SAI から送るのではなく端末側で打つしかない。SAI からの返信は「端末を離れているときに1ターン進めておく」用途で、戻ったら開き直す、が前提。

「処理中」の正はサーバ（子プロセスが exit するまで `replying` として `GET /api/sessions` / `GET /api/sessions/<id>` / `GET /api/feed` に載る）。画面はそれを見て仮バブルと閉じた入力欄を出すので、リロードしても別タブでも同じ状態になり、一覧のそのセッションには「返信中」が付く。1分を超えると仮バブルに経過（「処理中 3分」）が出て、5分を超えると色が変わる。`replying` が変わると `rev` も変わるので、JSONL が増えなくても画面は描き直す。プロセスが終わったのに行が増えなかったとき（`claude -p` が許可待ちで落ちた、フックが失敗した）は「返信は終わったが記録が増えなかった」と出て入力欄が開く。手がかりは `~/.agent-feed/reply.log`。`session_source` が `synth` のセッション、`unknown-<日付>` に丸められたセッション、`agent` が `unknown` のセッションは ID が合成なので再開できず、入力欄の代わりにその旨が出る。

#### 返信と許可

返信は非対話モード（`claude -p` / `codex exec`）で回すので、**許可ダイアログを出せない**。端末なら「このコマンドを実行していい？」と聞かれる場面（`gh pr create` など、設定で許可していないツール）は、非対話では拒否されて、エージェントは「許可が要る」と言って止まる。SAI からは答えられない。

先に許可しておくには、環境変数でサーバに追加の引数を渡す:

```sh
SAI_CLAUDE_ARGS='--allowedTools "Bash(gh *)"' pnpm start        # gh だけ通す
SAI_CLAUDE_ARGS='--permission-mode acceptEdits' pnpm start       # ファイル編集は聞かない（コマンドは聞く）
SAI_CODEX_ARGS='-s workspace-write' pnpm start                    # Codex: 作業ディレクトリへの書き込みまで
```

`claude` の `--allowedTools` は `~/.claude/settings.json` の `permissions.allow` と同じ書き方で、こちらは SAI からの返信にだけ効く（端末の許可設定はそのまま）。**SAI 自身は既定で何も付けない。** `--dangerously-skip-permissions` / `--permission-mode bypassPermissions` / Codex の `--dangerously-bypass-approvals-and-sandbox` も書けるが、返信の POST はブラウザから飛ぶので、その状態で別サイトからの CSRF が通ればエージェントが何でもできる（同一オリジンの検査で止めてはいる）。許可はツール単位で最小にする。

「フィード」は全チャンネルを時系列に流したもの（`/api/feed`）。フィードからも返信できる。全セッションが混ざっているので返信先を選ぶ必要があり、入力欄で半角の `@` を打つと候補が出て、↑↓ と Enter で選ぶと、Slack と同じく入力欄の中に表記（`@repo`。同じリポジトリが複数なら `@repo/branch`）が入り、入力欄の上のチップ（`→ #repo branch「タイトル」`）も差し替わる。表記は送信時に本文から外す。表記を手で消すか、チップの ✕ を押すと既定に戻る。何も選ばなければ一番新しい行のセッションに送る（既定でもチップに出る）。再開できないセッションは候補に薄く出て選べない。送る先は同じ `POST /api/sessions/<id>/reply`。

候補は**サイドバーの一覧に出ているセッション**（絞り込みと日数はサイドバーのもの。表示名・アイコンが付いていればそれで出る）を先に、一覧に無くてフィードにだけ出ている行のセッションを後ろに並べる。リポジトリ / ブランチ / タイトルで絞れる。一覧の取得は画面全体で 1 回で、サイドバーとフィードが同じ結果を見る。

### エンドポイント

| | |
| --- | --- |
| `GET /` | ビューア（`web/dist/index.html`） |
| `GET /assets/*` | ビルド成果物。`dist/` の外には出ない |
| `GET /api/sessions?days=7&repo=&agent=&date=&archived=` | セッション一覧（集計済み）。各セッションの `waiting` は人を待って止まっていれば「何を待っているか」、そうでなければ空。`filters` に絞り込み候補、`replying` に処理中の返信（ID → `{ since, text }`）も返す。既定ではアーカイブ済みを除き、`archived=1` でアーカイブ済みだけ（`total` と `filters` もその集合から） |
| `GET /api/sessions/<id>?days=30` | そのエンティティの全行と `replying`。`<id>` は `<セッション>@<リポジトリ>` |
| `POST /api/sessions/<id>/reply?days=90` | body `{ "text": "..." }`。そのセッションを `cwd` で再開して1ターン回すのを投げっぱなしにし、`202` を返す。合成 ID は `400`、進行中は `409`、別オリジンは `403` |
| `GET /api/sessions/<id>/meta` | 表示名・アイコン・アーカイブ。`{ "id", "meta": { "name"?, "icon"?, "archived_at"? } }`。無ければ `meta` は `{}` |
| `PUT /api/sessions/<id>/meta?days=90` | body `{ "name"?: "...", "icon"?: "🧪", "archived_at"?: "<ISO>" }` をいまの値に重ねる。省略したキーは据え置き、空文字や `null` は「消す」で、全部消えたらエントリごと消える。アイコンは絵文字1つ、名前は100文字まで、`archived_at` は読める時刻（違えば `400`）。窓の中に無いセッションは `404`、別オリジンは `403` |
| `GET /api/feed?days=3&repo=` | 生の行と `replying`。アーカイブ済みセッションの行は除く |

返信の実行は `server/runner.ts`。`claude` / `codex` は `detached` で起動して待たず、stdout/stderr は `~/.agent-feed/reply.log` に追記する（うまく動かないときはここを見る）。同じエンティティに同時に2本は走らせない。

集計はサーバ側（`server/aggregate.ts`）。エンティティのキー（`<セッション>@<リポジトリ>`、セッションが取れない行は `unknown-<日付>`）は `shared/entity.ts` にあり、サーバの集計と画面のリンクが同じ関数を使う。ファイルは `(mtime, size)` で覚えていて、変わっていなければ再パースしない（`server/store.ts`）。1日開きっぱなしにしても重くならないのはこのため。

レスポンスの形は `shared/types.ts` に1つだけ書いてあり、サーバの集計と画面の受け取りが同じ型を見る。フィールドを足すときはそこに足すと、片方だけ忘れたときに `pnpm typecheck` で止まる。

## 守ること

- **`record.py` は絶対に失敗しない。** 必ず exit 0。フックが落ちるとエージェント本体を止めてしまうので、記録に失敗しても黙って諦める。何が起きたか見たいときは `AGENT_FEED_DEBUG=1` で `~/.agent-feed/record-errors.log` に残る。15秒で自分を殺す保険も入っている
- **本物の Slack には投げない。** 投げ先が会社のワークスペースになるので、個人リポジトリのセッション記録がそこに流れるのは避ける
- **SAI は外に出さない。** `127.0.0.1` 限定。デプロイもホスティングもしない。中身は作業内容そのもの
- **ブラウザからコマンドが走る。** 返信は `claude` / `codex` を任意の `cwd` で起動する。ローカルで開いている別サイトからの CSRF でエージェントを走らせないよう、`POST` は `Origin` / `Sec-Fetch-Site` が同一オリジンでなければ `403`（どちらも無い curl などブラウザ以外は通す）。この確認は外さない。権限のバイパス（`--dangerously-skip-permissions` など）も付けない
- **一覧のタイトルに機密が乗りうる。** 仕事のリポジトリのセッションだと issue の内容がそのまま出る。スクリーンショットを撮るときは自分で気をつける

## 環境変数

| | |
| --- | --- |
| `SAI_HOME` | このリポジトリの場所。上のフック設定例が `$SAI_HOME/feed/record.py` として使う（`record.py` やサーバ自身は読まない） |
| `AGENT_FEED_DIR` | 出力先（既定 `~/.agent-feed`）。`record.py` とサーバの両方が見る |
| `AGENT_FEED_DEBUG` | `1` で `record.py` の例外をログに残す |
| `CODEX_HOME` | Codex のホーム（既定 `~/.codex`） |
| `SAI_PORT` | サーバの既定ポート（既定 `8787`） |
| `SAI_CLAUDE_BIN` | 返信で起動する `claude` の実行ファイル（既定は PATH の `claude`）。launchd などで PATH が最小のときに |
| `SAI_CODEX_BIN` | 同じく `codex` |
| `SAI_CLAUDE_ARGS` | 返信の `claude -p --resume` に足す引数。空白区切りで、空白を含む値は `"…"` か `'…'` で囲む。例: `--allowedTools "Bash(gh *)"`、`--permission-mode acceptEdits`。「返信と許可」の項を読んでから |
| `SAI_CODEX_ARGS` | 同じく `codex exec resume` に足す引数。例: `-s workspace-write` |
