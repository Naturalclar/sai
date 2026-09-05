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
| `UserPromptSubmit` | 人が入力した | `user_text` に打った文をそのまま載せた行（本文 `text` は無い）。ターン完了を待たずに自分側のバブルが出る。直前が待ちの行なら、その解消の合図にもなる。入力が取れなかったときは待ちの直後だけ合図として書く。バックグラウンドのタスク完了で Claude Code が差し込む `<task-notification>` でも鳴るが、人の入力ではないので載せない（同じく待ちの直後だけ合図） |

`record.py` は待ちのフックで **stdout に何も出さない**（`decision` を出すと許可の判断そのものに触ってしまう）。許可するかどうかはいつも通り端末で答える。

**フックは足し算で鳴る。** リポジトリ側の `.claude/settings.json` にも `Stop` フックがあると、ユーザー設定の分と両方が動いて 1 ターンが 2 行になる（試作を置いていたリポジトリで実際に起きた）。SAI を更新したら `record.py` の向け先も同じ checkout を指しているか確かめる。**記録側が古いと画面が知らせる**: 行には `v`（`record.py` の `RECORD_VERSION`）が載り、窓の中の一番新しい行の `v` が最新より小さいとヘッダの下に「記録側の `record.py` が古い」と出る。`v` の無い行は試作か古い `record.py` のもの。

**Codex CLI** — `~/.codex/config.toml` に:

```toml
notify = ["python3", "/absolute/path/to/sai/feed/record.py"]
```

こちらは絶対パスで。`notify` は引数の配列をそのまま実行する（シェルを通らない）ので、`$SAI_HOME` のような変数は展開されない。`notify` の JSON が「最後の引数」で来るか stdin で来るかは資料によって食い違うので、`record.py` は両方受ける。

**`notify` は 1 つしか持てない。** Codex Computer Use のクライアントなど、すでに別の受け手を `notify` に入れているなら、上をそのまま書くとそちらが動かなくなる（逆に、そちらを残したままだと SAI に Codex の行が 1 行も来ない）。その場合は受け手を順に呼ぶ小さなラッパーを 1 つ置いて、`notify` はそれだけを指す。Codex が最後の引数に付けるイベントの JSON を `"$@"` でそのまま渡す。どれかが失敗しても他を止めず、常に exit 0:

```sh
#!/usr/bin/env bash
# sai-codex-notify - Codex の notify を複数の受け手に配る
set -uo pipefail
cu="$HOME/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"
[ -x "$cu" ] && "$cu" turn-ended "$@" >/dev/null 2>&1 || true
script="${SAI_HOME:-$HOME/src/sai}/feed/record.py"
[ -f "$script" ] && python3 "$script" "$@" >/dev/null 2>&1 || true
exit 0
```

```toml
notify = ["/Users/<me>/.scripts/sai-codex-notify"]
```

ラッパーはシェルスクリプトなので、その中では `$SAI_HOME` が使える。向け直したら Codex で 1 ターン回し、`~/.agent-feed/` の行に `"agent": "codex"` が増えて `session_source` が `rollout` になることを見る（`synth` なら下の「Codex のセッション ID」を疑う）。

### 2. 画面をビルドしてサーバを立てる

```
pnpm install && pnpm build
pnpm start                                   # http://127.0.0.1:8787/
pnpm start --port 9000 --feed-dir ~/.agent-feed   # pnpm は「--」もそのまま渡すが、先頭の「--」は落とすので付けてもよい
```

pnpm は 12 系（設定は `pnpm-workspace.yaml`）、Node は 22.18 以上が要る。

サーバは `web/dist/` を配る。未ビルドなら `/` にその旨が出る。`file://` で開くと fetch が CORS で止まるので、必ずこのサーバ経由で開く。`127.0.0.1` 以外には bind を拒否する。

画面を触るときはサーバを立てたまま `pnpm dev`。Vite が `/api` を `127.0.0.1:8787` に流す。

`main` を取り込んだときは、サーバを止めずに別のターミナルで `git pull && pnpm build` するだけでいい。`pnpm build` を忘れて `web/dist/` が `web/src` / `shared` より古いままだと、画面のヘッダの下に「画面のビルドが古い」と出る（サーバが mtime を比べて `build_stale` で伝える。`pnpm dev` では出ない）。サーバは `web/dist/` を毎回ディスクから読み、`/api/*` の応答に `X-SAI-Build`（`dist/index.html` の更新時刻）を付けるので、開いているブラウザは 3 秒以内に自分でリロードする。`server/` や `shared/` が変わったときの再起動まで任せたければ `pnpm start:watch`（`node --watch`）で立てる。

```
pnpm lint        # oxlint（web/src, server, shared）
pnpm typecheck   # tsc（web と server の両方）
pnpm test        # node:test（server/、shared/、web/src/）
pnpm test:feed   # python3 -m unittest（feed/）
pnpm build       # typecheck してから vite build
pnpm start:watch # server/ shared/ が変わったら自動で再起動（node --watch）
```

### （任意）tailnet に出す

iPad やスマホから見たいときは **Tailscale Serve** で tailnet 内にだけ出す。アプリの bind は `127.0.0.1` のまま（Serve が前段で TLS を受けて 127.0.0.1 にプロキシする）。`tailscale funnel`（インターネット公開）は使わない。

```
tailscale serve --bg 8787                 # https://<このマシン>.<tailnet>.ts.net/ → 127.0.0.1:8787
tailscale serve status                    # 出ているものの確認
tailscale serve --bg 8787 off             # やめる
```

Serve 経由のリクエストには `Tailscale-User-Login`（誰か）と `X-Forwarded-For`（tailnet 側のアドレス）が付く。サーバはこのヘッダを**そのまま信じず**、`tailscale whois <X-Forwarded-For>` でローカルの Tailscale デーモンに本人を引き直し、一致したときだけ通す（`server/auth.ts`）。一致しなければ `401`。ヘッダが無いリクエストはループバックからの直アクセスとして通す。通ったログイン名は `/api/health` と一覧の `viewer` に載り、画面右上の自分のメニューに出る。

同じホスト上から偽のヘッダを付けても通らないことは、こう確かめる（`401` になるのが正しい。`200` なら二段構えが効いていない）:

```
curl -H 'Tailscale-User-Login: someone@example.com' http://127.0.0.1:8787/api/health
```

`whois` の結果はアドレスごとに 30 秒キャッシュする（3 秒ごとのポーリングで毎回デーモンに聞かない）。`tailscale` の実行ファイルは PATH、無ければ macOS の GUI 版（`/Applications/Tailscale.app/Contents/MacOS/Tailscale`）、`SAI_TAILSCALE_BIN` で差し替えられる。Serve 経由だとブラウザの `Origin` は `https://<MagicDNS 名>` になるので、書き込みの同一オリジン検査は Serve が付ける `X-Forwarded-Proto` でスキームを合わせる。

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
  "thinking": "背中は前回ラットプルダウンだったので、今回はロウ系を中心にする",
  "model": "claude-fable-5-1",
  "first_user_text": "背中のメニューを出して"
}
```

| フィールド | |
| --- | --- |
| `v` | 記録側の版（`record.py` の `RECORD_VERSION`。`shared/types.ts` にも同じ値があり、ずれると `pnpm test:feed` が止まる）。行の形を変えるたびに上げる。無い行は試作か古い `record.py` が書いたもの（1 扱い） |
| `agent` | `claude` / `codex` / `unknown` |
| `session_source` | `payload`（ペイロードから）/ `rollout`（Codex のファイルから）/ `synth`（時間で合成）。一覧の信頼度がここで分かる |
| `event` | 何の行か。ターン完了は `Stop`（Claude）/ `agent-turn-complete`（Codex）。人を待って止まった行は `PermissionRequest` / `PreToolUse` / `Notification`、人が答えて再開した行は `UserPromptSubmit`。読み方は `shared/events.ts` の `eventKind()` にまとめてあり、集計と画面が同じ判定を使う |
| `text` | ターン完了なら最後のアシスタント発話。Claude は `transcript_path` の末尾から、Codex は `last-assistant-message`。2,000文字で切る。待ちの行なら「何を待っているか」（300文字）、再開の行は空 |
| `user_text` | そのターンの入力（人が打った文）。Claude の `UserPromptSubmit` の行はペイロードの `prompt` そのもの。`Stop` の行は `transcript_path` を末尾から遡って最後の入力（ツールの戻りや差し込みは飛ばす。スラッシュコマンドは `/foo 引数` に戻す。バックグラウンドのタスク完了の通知 `<task-notification>`（`promptSource: system`）で始まったターンは人の入力が無いので空）、Codex は `input-messages`。画面2で自分側のバブルになり、一番新しい行のものが一覧のタイトルになる。2,000文字で切る |
| `thinking` | そのターンの思考。Claude は `transcript_path` の最後のターン（最後の入力より後）の `thinking` ブロックの本文を `\n\n` で繋いだもの（`signature` だけのブロックは飛ばす）、Codex は rollout の最後のターンの `reasoning` の `summary[].text`。**無いことが多い**（下の「先に確かめた前提」の 4）。ターン完了の行だけ。4,000文字で切る（先頭側を残す）。画面2のエージェントのバブルに折りたたんで出す。`GET /api/feed` の行からは落とす |
| `model` | そのターンを回したモデル。Claude は `transcript_path` の最後の assistant 行の `message.model`（`claude-fable-5-1` など。CLI が合成した `<synthetic>` は飛ばす）、Codex は rollout の最後の `turn_context.model`（`gpt-5.6-sol` など）。ターン完了の行だけ。画面2の見出しに出す |
| `pane` / `pid` | セッションが開いている tmux のペイン（`%12`。フックが受け取る `TMUX_PANE`）と本体の pid（Claude は `CLAUDE_PID`、Codex は notify の親）。SAI の返信をそのペインに打ち込むのに使う。tmux の外なら `pane` は空 |
| `first_user_text` | 最初のユーザー発話。`user_text` が1行も無い古いセッションのタイトルに使う。300文字で切る |

日付は `Asia/Tokyo` で切る。

`first_user_text` は1行目だけでなく**毎行**に載せている。集計は「一番古い行の値」を使うので結果は同じで、`days` で切った窓の外にセッションの1行目が落ちてもタイトルが消えない。

### セッションの表示名とアイコン

一覧の名前は入力（`user_text` / `first_user_text`）から自動で作るが、ブラウザから自分で付けた表示名と、手元の画像ファイルのアイコンで上書きできる（チャット見出しのアイコンボタン。鉛筆が「名前を付ける / 名前を変える」、写真が「画像を選ぶ / 画像を変える」、ゴミ箱が「画像を消す」。文字は出さないが、ホバーと読み上げでは同じ文言が出る。名前を消すのは入力欄を空にして保存）。付けると、一覧とチャット見出しのほかに、**チャットのエージェント側のバブルの発言者名とアバター**もそれになる（無ければ「Claude Code」/「Codex CLI」と頭文字）。フィードでも同じで、サイドバーの一覧に載っているセッションの分は反映される（一覧の日数の窓に無いセッションは固定の名前に落ちる）。自分側の「あなた」は変わらない。

表示名は JSONL ではなく `~/.agent-feed/session-meta.json` に持つ。

```json
{ "sess-abc@kanban": { "name": "背中メニュー" } }
```

キーはエンティティID（`<セッション>@<リポジトリ>`）。記録側（`record.py`）はこのファイルを知らないし、集計（`aggregate()`）も触らない。サーバが応答を返すときに載せるだけなので、消しても履歴は壊れない。

写真のボタン（「画像を選ぶ」）でファイルを選ぶと**加工のモーダル**が開き、正方形の枠に対してドラッグで位置、ホイールかスライダで大きさを決めて「これにする」を押すと、**256px 四方・角丸（一辺の 20%）の PNG** にしてから置く。元のファイルは送らない（ブラウザの Canvas で加工する。サーバ側に画像処理は無い）。選べるファイルは 20MB まで（`ICON_SOURCE_MAX_BYTES`）、置く加工後の PNG は 1MB まで（`ICON_MAX_BYTES`）。GIF はアニメーションが止まる（1 フレーム目）。画面の角丸 CSS も同じ 20% なので、加工前に置いた古い画像も同じ見た目で出る。

アイコン画像は `~/.agent-feed/session-icons/<sha1(ID) の先頭16桁>.<png|jpeg|gif|webp>` にファイルで置く（`session-meta.json` には書かない。ファイルの有無が正）。PNG / JPEG / GIF / WebP で 1MB まで（画面から置くものは加工後の PNG。API を直接叩けば他の種類も置ける）。種類はファイルの中身（先頭のバイト列）で見るので、拡張子だけ画像のファイルは置けない（SVG も受けない）。一覧の各セッションには `icon`（`/api/sessions/<id>/icon?v=<mtime>`）として URL が載り、差し替えると `v` が変わってブラウザのキャッシュを引かない。画像を置いた・消しただけでも一覧の `rev` が変わるので、開いている画面にそのまま反映される。昔の絵文字のアイコン（`icon` キー）は読むときに捨てる。

### 自分の表示名とアイコン

チャットの自分側のバブルは既定では「あなた」（名前）と「私」（アバター）。**ヘッダー右端の自分のアイコン**を押すとメニューが開き、「表示名とアイコン」で名前と画像を付けられる。付けると、過去の行も送信中の仮バブルも、その名前とアバターになる。SAI は1人のローカルの道具なのでプロフィールは1つ。

表示名は `~/.agent-feed/profile.json`（`{ "name": "Jesse" }`）、アイコンはセッションのアイコンと同じ `~/.agent-feed/session-icons/` に固定の鍵 `me` で置く（エンティティ ID には必ず `@` が入るので衝突しない）。画像の加工（正方形・角丸の PNG）もセッションのアイコンと同じモーダルを通す。記録側（`record.py`）も集計も触らず、サーバが応答の `profile` に載せるだけ。名前や画像を変えると `rev` が変わるので、開いている別のタブにもポーリングで反映される。

### アーカイブ

終わったセッションは**アーカイブ**して一覧とフィードから隠せる（Slack のチャンネルのアーカイブと同じで、消すのではなく既定では見えなくする）。これも同じ `session-meta.json` に `archived_at`（アーカイブした時刻、ISO）として持つ。

```json
{ "sess-abc@kanban": { "name": "背中メニュー", "archived_at": "2026-09-02T07:40:00.000Z" } }
```

「アーカイブ済みか」は `archived: true` のような印ではなく、サーバが応答時に **`archived_at >= そのセッションの最後の行の ts`** で決める。アーカイブしたあとに端末でそのセッションを続けると最後の行が `archived_at` を追い越すので、メタを書き換えずに自動で一覧に戻る。「戻す」は `archived_at` を消すだけ。`synth`（時間で合成した ID）のセッションは集計の切れ方で付け先がずれるのでアーカイブできない。

### 履歴はリポジトリに入れない

`~/.agent-feed/` はリポジトリの外。作業内容の断片が入るので、うっかりコミットされない場所に置く。`.gitignore` の `*.jsonl` / `.agent-feed/` / `sessions/` は、手元にコピーしたときの保険として最初のコミットから入っている。

## 先に確かめた前提

**素朴に作ると動かない点が3つと、期待しすぎると外れる点が1つある。**

### 1. 「セッション終了」は掴めない

- Claude Code の `SessionEnd` は `/clear` のときしか発火しない
- Codex の `notify` はイベントが `agent-turn-complete` の1種類だけ

→ 共通して掴めるのは「ターン完了」だけなので、Claude 側も `Stop` フックを使う。1行 = 1ターン。セッションは後段でまとめる。

### 2. Codex の notify ペイロードにセッションIDが無い

Claude の `Stop` は `session_id` を stdin の JSON に含むが、Codex の `agent-turn-complete` には無い。

→ **記録時に、cwd が一致する直近の rollout ファイル（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`）からセッションIDを引く。** `session_index.jsonl` は壊れていることがある（`codex resume --all` が「No sessions yet」になる既知の問題）ので、索引ではなくファイル名から直接取る。

それも取れなかったときは `(repo, cwd, agent)` が同じで前の行から**30分以内**なら同じセッションとみなし、ID は `synth-<repo>-<開始時刻>` にする。合成であることが後から分かるよう `session_source` を `synth` にする。一覧では「合成」の印が付く。

もう1つ落とし穴がある。**Codex は人のターンとは別に裏で回す LLM 呼び出し（タスクのタイトル生成、次にやることの提案、安全性チェック）でも `agent-turn-complete` を鳴らす。** これにもセッション ID は無く、rollout にも書かれないので、そのまま記録すると同じ cwd で進行中のセッションに `{"title":"…"}` のような JSON だけの返答が紛れ込む。`record.py` は `input-messages` が既知の内部プロンプトで始まるか、返答が JSON オブジェクトだけで入力に内部プロンプトの決まり文句（`Do not answer the request`）があれば、行を書かない（`is_codex_internal_turn()`）。新しい種類の内部呼び出しが増えると JSON だけのバブルとして現れるので、そのときは接頭辞の一覧（`_CODEX_INTERNAL_PROMPT_PREFIXES`）に足す。

### 3. 「待っている」はターン完了とは別の行で掴む

許可待ち・質問待ち・プランの承認待ちで止まっている間は `Stop` が来ないので、ターン完了だけ記録していると一覧では「最後のターンから動いていない」ようにしか見えない。

→ 止まった瞬間に鳴る `PermissionRequest`（許可）と `PreToolUse`（`AskUserQuestion` / `ExitPlanMode`）で「何を待っているか」を待ちの行として書き、後に `Stop` か `UserPromptSubmit` が来たら解消したとみなす（集計は「最後の行が待ちか」だけを見る）。`Notification` は 6〜60 秒遅れて鳴る補欠。

確かめた範囲で分かっていること:

- `PermissionRequest` には `tool_use_id` が無い（`PreToolUse` にはある）。重複は「同じセッションの直前の行と同じ text」で落とす
- 非対話（`claude -p`。画面からの返信もこれ）で許可が要るツールを呼ぶと、**自動で拒否されて `PermissionRequest` は鳴らない**（Claude Code 2.1.258 で確認）。`AskUserQuestion` は `-p` ではそもそもツールとして出ない。つまり返信経路で許可待ちに入ることは無く、拒否されたあとの返答が普通のターンとして届く
- `AskUserQuestion` / `ExitPlanMode` で `PermissionRequest` が鳴るかは端末でしか確かめられないので、`PreToolUse` を matcher 付きで並走させている。両方鳴っても同じ text なので1行になる
- Codex の `notify` は `agent-turn-complete` しか無いので、Codex の承認待ちは記録できない

### 4. transcript に残る思考は短い要約で、ターンの 4 分の 1 程度

Claude Code の transcript には assistant の `thinking` ブロックが書かれるが、手元の 12 本（154 ターン）を数えると **781 個のうち本文があるのは 77 個（10%）** で、残りは `signature` だけ。思考が読めるターンは **35 / 154（23%）**、読めるときも 1 ターン合計で中央値 200 文字、最大 530 文字（Claude Code 2.1.258）。

→ `thinking` は「モデルの推論を全部読める」ものではなく、**あれば出す**。大半のバブルには何も付かない。Codex の rollout の `reasoning` は既定では `summary: []` + `encrypted_content` で何も読めない（`~/.codex/config.toml` の `model_reasoning_summary` で summary が入るかは未確認）。

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
| モデル（画面2の見出しだけ） | 一番新しいターンの `model`。途中で変わっていれば「+N」（マウスを乗せると順に全部）。変わった位置のバブルにもモデル名が小さく出る。一覧とフィードには出さない |
| タイトル | 一番新しい `user_text` の1行目。画面から返信しても端末で続きの指示を打っても、次のターンが記録された時点で最後の入力に変わる。`user_text` が無ければ `first_user_text`、それも無ければ最初の `text` の1行目。60文字で切る |
| 最後の発言 | 最後の `text` の1行目（Markdown の記号は落とす） |
| 印 | `session_source` が `synth` なら「合成」。最後の行が待ちの行（`waiting`）なら「待機中」（マウスを乗せると何を待っているか）。画面からの返信を処理中なら「返信中」。アーカイブ済みなら「アーカイブ」（「アーカイブ済みを見る」のときだけ出る） |

絞り込み（リポジトリ / エージェント / 日付 / 日数）はサイドバーの上。「アーカイブ済みを見る」を押すとアーカイブ済みのセッションだけが薄く出る（既定では出ない）。項目にマウスを載せる（かフォーカスする）と右上に「アーカイブ」が出て、セッションを開かずにその場でアーカイブできる（「アーカイブ済みを見る」中は「戻す」）。フィードのリポジトリはここで選んだものに従う（同じ画面に「リポジトリ」を2つ出さない）。フィードの日数だけはチャット側の右上で選ぶ。

### チャット

Slack のチャット風。1ターンは「自分の入力（`user_text`）→ エージェントの返答（`text`）」の2つのバブルで出るので、往復で読める。Claude は入力した瞬間に `UserPromptSubmit` の行が先に届くので、自分のバブルはターン完了を待たずに出る（続く `Stop` の行に載っている同じ入力は重ねない）。同じ発言者の連続した発言（10分以内）は Slack と同じくまとめる。人を待って止まった行（`PermissionRequest` など）は `⏳ 許可待ち: Bash: rm -rf node_modules` のような**待ちのバブル**になり、後にターン完了か再開の行が来ていれば薄く残る。再開の行（`UserPromptSubmit`）は本文が無いのでバブルにしない。リポジトリ名がチャンネル。自分のバブルは Markdown にせずそのまま出す。エージェントのバブルにそのターンの思考（`thinking`）があれば、本文の上に「▸ 思考（N 文字）」の折りたたみが付き、押すと薄い字でそのまま（Markdown にせず）出る。見出しの「思考を全部開く」で全部開いた状態にでき、localStorage に残る。フィードには出さない（API の行からも落とす）。3秒ごとに更新するが、サーバが返す `rev` が変わっていなければ state を触らない（= 描き直さない）。タブが隠れている間は止まる。

バブルの本文は **Markdown として描く**（`shared/markdown.ts` → `web/src/Markdown.tsx`）。扱うのはエージェントの返答で頻出するものだけ: URL と `[ラベル](URL)` のリンク（別タブで開く。先が http(s) 以外ならリンクにしない）、`**太字**`、`` `コード` ``、`- ` / `1. ` の箇条書き、`#` 見出し、` ``` ` のコードブロック、`> ` 引用、`---` 罫線。それ以外はそのまま改行を保って出す。HTML 文字列は組み立てず React 要素にするので、`text` に HTML が入っていてもただの文字として出る。一覧の「最後の発言」は同じ字句解析で記号だけ落とした1行。

チャット見出しの「アーカイブ」でそのセッションを一覧とフィードから隠せる（アーカイブ済みなら「戻す」）。アーカイブ済みのセッションは `#/s/<id>` で直接開けば普通に読めるが、入力欄は出ない（返すなら先に戻す）。

セッションを開いているときは、下の入力欄から**そのセッションに続きの指示を送れる**（Enter で送信、Shift+Enter で改行）。サーバが `cwd` でセッションを非対話モードの CLI で再開して1ターン回す:

| エージェント | コマンド |
| --- | --- |
| Claude Code | `claude -p --resume <session> -- "<text>"` |
| Codex CLI | `codex exec resume <session> -- "<text>"` |

**返信のモデル**は見出しの「返信:」で選べる（そのセッションで出てきたモデル、Claude なら別名 `fable` / `opus` / `sonnet` / `haiku`、あとは自由入力。「既定」に戻せる）。選ぶと `session-meta.json` の `model` に残り、次の返信から Claude は `--model <m>`、Codex は `-m <m>` が付く（`SAI_CLAUDE_ARGS` に `--model` があってもセッションの設定が後ろに来て勝つ）。見出しの `claude-fable-5-1` のような表示は**実際に使われた**モデル（記録から）で、設定とは別。返信が終わって行が届けば表示のほうも変わる。

注意: Claude は `--resume` に `--model` を付けると**セッションのモデル設定そのものが変わる**（確認済み: `--model sonnet` で 1 回返信したあと、`--model` 無しで再開しても `claude-sonnet-5` のまま）。つまり SAI から返信のモデルを変えると、端末でそのセッションを再開したときのモデルも変わる。端末で `/model` を打ち直せば戻る。

`--` は本文が `-` で始まっても（`-v` や `--help`）CLI のフラグとして解釈されないようにするため。

回したターンが完了すれば既存のフック（Stop / notify）が動いて JSONL に1行増えるので、返信の結果は今のポーリングでそのまま画面に流れてくる。送信直後は「送信中…」の仮バブルが出て、`UserPromptSubmit` の行が届けば本文はそちらの本物のバブルに置き換わり「処理中」の1行だけ残る。行が増えたら消える（増えた行の `user_text` が同じ文なので、見た目はそのまま本物の自分のバブルに変わる）。

#### 端末（tmux）で開いているセッションには打ち込む

セッションが **tmux のペインで開いていれば、返信はそのペインに打ち込む**（`tmux load-buffer` → `paste-buffer -p` → `send-keys Enter`）。別プロセスを立てないので、端末に入力と返答がそのまま出て、フックが普通のターンとして JSONL に足す。開いているセッションに 1 ターン足すだけなのでプロンプトキャッシュも効き、トークンも一番少ない。見出しに「端末」の印が付き、`POST /reply` の応答は `via: "terminal"`。

「開いているか」は行の `pane`（フックが受け取る `TMUX_PANE`）と `pid`（Claude は `CLAUDE_PID`、Codex は notify の親）で見る。一番新しい行に両方あり、`pid` が生きていれば端末で開いている。打ち込む前に、ペインが今もあってその `pid` がペインのプロセスの子孫であること（別のセッションに打ち込まない）、入力欄が空でダイアログ中でないこと（打ちかけの文字に混ぜない、許可の答えにしない）を確かめ、だめなら `409` で何も打たない。ペインが消えていれば下の別プロセスに戻る。

- 打ち込んだ返信の許可ダイアログは**端末側に出る**（下の `--permission-prompt-tool` は使わない）。SAI には待ちの行で「許可待ち」が出るが、答えるのは端末
- 「処理中」は、その後にターン完了の行が届いたら解消（30 分届かなければ諦める）
- `SAI_TERMINAL=0` で切る（常に別プロセス）。`SAI_TMUX_BIN` で `tmux` の実行ファイルを差し替え
- tmux 以外の端末と Claude Desktop には届かない（下のとおり別プロセスで回る）

#### 端末で開いていないセッションは別プロセスで回す

**別プロセスで回した返信と返答は、そのセッションを開いている端末や Desktop の画面には出ない。** SAI には出るし履歴にも残るが、開いている対話側は会話をメモリに持っていて、外で回ったターンを読み直さない。入力欄の下にもこの注意を出している。確かめたこと（Claude Code 2.1.258 / Codex CLI 0.139）:

- `claude -p --resume <session>` は同じセッションのトランスクリプト（`~/.claude/projects/<project>/<session>.jsonl`）に**追記する**。セッション ID も同じで、別セッションには分岐しない（`--fork-session` を付けたときだけ分岐する）
- `codex exec resume <session>` も同じ rollout ファイル（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`）に追記する。新しい rollout は作らない
- なので、端末を閉じて `claude --resume <session>`（Codex は `codex resume <session>`）で**開き直せば**、SAI から送った返信とその返答も履歴に並ぶ
- 開いたままの端末で続きを打つと、その端末は SAI のターンを知らないまま進む。Claude Code の資料も「同じセッションを2つの端末で再開すると、両方のメッセージが1つのトランスクリプトに交互に入る」としている（[Manage sessions](https://code.claude.com/docs/en/sessions)）。壊れはしないが、対話側のエージェントは SAI で頼んだことを覚えていない
- Claude Desktop は CLI と「別のセッション履歴」を持つ（[Desktop の資料](https://code.claude.com/docs/en/desktop)）。`settings.json` は共有なのでフックは動いて SAI には出るが、Desktop のセッションを `claude -p --resume` で再開できるか、Desktop の画面に出るかは未確認（この Mac に Desktop が無い）

対話側にも出したいなら、SAI から送るのではなく端末側で打つしかない。SAI からの返信は「端末を離れているときに1ターン進めておく」用途で、戻ったら開き直す、が前提。

「処理中」の正はサーバ（子プロセスが exit するまで `replying` として `GET /api/sessions` / `GET /api/sessions/<id>` / `GET /api/feed` に載る）。画面はそれを見て仮バブルと閉じた入力欄を出すので、リロードしても別タブでも同じ状態になり、一覧のそのセッションには「返信中」が付く。1分を超えると仮バブルに経過（「処理中 3分」）が出て、5分を超えると色が変わる。`replying` が変わると `rev` も変わるので、JSONL が増えなくても画面は描き直す。プロセスが終わったのに行が増えなかったとき（`claude -p` が許可待ちで落ちた、フックが失敗した）は「返信は終わったが記録が増えなかった」と出て入力欄が開く。手がかりは `~/.agent-feed/reply.log`。`session_source` が `synth` のセッション、`unknown-<日付>` に丸められたセッション、`agent` が `unknown` のセッションは ID が合成なので再開できず、入力欄の代わりにその旨が出る。

サーバは処理中の分を `~/.agent-feed/replying.json`（エンティティ ID → `pid` / `since` / `text`）にも書き、再起動したら読んで**生きている pid の分だけ引き取る**（死んでいた分は捨てる。以後も見るたびに生存を確かめる）。返信の子プロセスは detached なのでサーバの再起動に巻き込まれない。引き取るので、`pnpm start:watch` の再起動をまたいでも「処理中」は消えず、同じセッションへの 2 つ目の返信は `409` のまま、生き残った返信からの許可の `POST /api/approvals` も通る。答え待ちの承認（下）はメモリだけなので、再起動で消えた分は MCP 側が取りに来なくなった時点で拒否扱いになる。

#### 返信と許可

返信は非対話モード（`claude -p` / `codex exec`）で回すので、**許可ダイアログを出せない**。端末なら「このコマンドを実行していい？」と聞かれる場面（`gh pr create` など、設定で許可していないツール）は、非対話では拒否されて、エージェントは「許可が要る」と言って止まる。SAI からは答えられない。

先に許可しておくには、環境変数でサーバに追加の引数を渡す:

```sh
SAI_CLAUDE_ARGS='--allowedTools "Bash(gh *)"' pnpm start        # gh だけ通す
SAI_CLAUDE_ARGS='--permission-mode acceptEdits' pnpm start       # ファイル編集は聞かない（コマンドは聞く）
SAI_CODEX_ARGS='-s workspace-write' pnpm start                    # Codex: 作業ディレクトリへの書き込みまで
```

`claude` の `--allowedTools` は `~/.claude/settings.json` の `permissions.allow` と同じ書き方で、こちらは SAI からの返信にだけ効く（端末の許可設定はそのまま）。**SAI 自身は既定で何も付けない。** `--dangerously-skip-permissions` / `--permission-mode bypassPermissions` / Codex の `--dangerously-bypass-approvals-and-sandbox` も書けるが、返信の POST はブラウザから飛ぶので、その状態で別サイトからの CSRF が通ればエージェントが何でもできる（同一オリジンの検査で止めてはいる）。許可はツール単位で最小にする。

### 返信中の許可・質問に画面から答える

端末と同じく、返信で回したエージェントが **許可（ツール実行の確認）や `AskUserQuestion` で止まったら、SAI のチャットに ⏳ のバブルと [許可] [常に許可] [拒否]（質問なら選択肢）が出て、そこから答えられる**。答えるまでエージェントは待っていて、一覧には「待機中」が付く。

仕組みは `claude -p` の `--permission-prompt-tool`。SAI は返信の `claude` に自分の MCP サーバ（`server/approve-mcp.ts`。stdio、依存ゼロ）を `--mcp-config` で足し、許可が要るたびにそのツールが呼ばれる。ツールは SAI サーバに預けて（`POST /api/approvals`）答えが付くまで待ち（`GET /api/approvals/<id>?wait=1`）、画面の答え（`POST /api/approvals/<id>/answer`）をそのまま CLI に返す。

```
claude -p --resume … --mcp-config '{"mcpServers":{"sai":…}}' --permission-prompt-tool mcp__sai__approve
   │ 許可が要る
   ▼
approve-mcp.ts ──POST /api/approvals──▶ SAI サーバ ◀──POST /api/approvals/<id>/answer── 画面の [許可] [拒否]
               ◀─{ behavior: allow | deny }─┘
```

- 答え待ちはサーバのメモリだけ。返信のプロセスが終われば（許可を待たずに落ちた、`claude` を kill した）その分は拒否扱いで消える。MCP 側が 90 秒取りに来なければ捨てる
- `AskUserQuestion` は質問と選択肢がそのまま出て、全部に答えると `answers` 付きで返す（複数選択は 1 つだけ選ぶ）。`ExitPlanMode` はプランの先頭が出て、許可すれば進む
- **[常に許可]** は端末の「今後も許可」と同じ。決定に `updatedPermissions`（`Bash(gh pr:*)` のような Claude の許可ルール。`destination: localSettings`）を付けて返すと、CLI が返信先の cwd の `.claude/settings.local.json` に書き、次のプロセスからその形は聞かれない（CLI 2.1.259 で確認）。ルールは SAI が組み立てる（`shared/approvals.ts` の `alwaysAllowRule`。CLI は候補を送ってこない）: Bash はコマンドの先頭 1 語、`gh` / `git` / `npm` のようにサブコマンドを持つ CLI は 2 語で前方一致。MCP ツールはそのツール名。Edit / Write などファイル系と `AskUserQuestion` / `ExitPlanMode` には出さない（設定に焼くには広すぎる）。ボタンにマウスを乗せると書かれるルールが見える。「常に拒否」は無い
- 答える口は同一オリジンのみ（`isCrossOrigin`）。ここが通ると別サイトから許可が押せてしまうので外さない
- **Claude だけ。** Codex に同等の口は無い（返信は今までどおり、承認が要るものは拒否される）
- 外すなら `SAI_APPROVE=0`。運用者が `SAI_CLAUDE_ARGS` に自前の `--permission-prompt-tool` を入れていれば SAI は足さない。`--mcp-config` は追加なので、`~/.claude.json` や `.mcp.json` の MCP サーバはそのまま使える（`--strict-mcp-config` は付けない）
- 返信のプロセスと画面の間は `127.0.0.1` の HTTP だけで、外には出ない。MCP の子プロセスに渡す宛先（`SAI_URL`）は**サーバ自身が待ち受けているアドレス**（`http://127.0.0.1:8787` など。`selfUrl()`）で、ブラウザの `Host` は使わない。tailscale serve 経由（`https://<host>.ts.net` → `127.0.0.1:8787`）で開いた画面から返信しても、子プロセスは同じマシンにいるのでループバックに戻ってくる（`Host` を使うと `http://<host>.ts.net` の 80 番に投げて「SAI に届かない: fetch failed」になる）

「フィード」は全チャンネルを時系列に流したもの（`/api/feed`）。フィードからも返信できる。全セッションが混ざっているので返信先を選ぶ必要があり、入力欄で半角の `@` を打つと候補が出て、↑↓ と Enter で選ぶと、Slack と同じく入力欄の中に表記（`@repo`。同じリポジトリが複数なら `@repo/branch`）が入り、入力欄の上のチップ（`→ #repo branch「タイトル」`）も差し替わる。表記は送信時に本文から外す。表記を手で消すか、チップの ✕ を押すと既定に戻る。何も選ばなければ**一番新しい行のセッションのうち、返信を処理中でないもの**に送る（既定でもチップに出る）。A に返信した直後は A が処理中なので、次に新しい B が既定になり、そのまま打てば B に届く。複数のセッションと並行して話せる。処理中のセッションは候補に「処理中」が付き、選ぶと送信ボタンが止まって「`#A` は前の返信を処理中。`@` で別のセッションに返信できます」と出る（全部が処理中のときだけ送れない）。入力中は既定が勝手に変わらない。再開できないセッションは候補に薄く出て選べない。送る先は同じ `POST /api/sessions/<id>/reply`。

候補は**サイドバーの一覧に出ているセッション**（絞り込みと日数はサイドバーのもの。表示名・アイコンが付いていればそれで出る）を先に、一覧に無くてフィードにだけ出ている行のセッションを後ろに並べる。リポジトリ / ブランチ / タイトルで絞れる。一覧の取得は画面全体で 1 回で、サイドバーとフィードが同じ結果を見る。

### 一言コメントと性格（digest）

エージェントの返答は長い説明になりがちで、フィードを眺めるには重い。`SAI_DIGEST=1` でサーバを起動すると、**新しく届いたターン完了の行**ごとに本文を **1〜2 文の一言コメント**（「#35 マージしたよ！ブランチも消しといた。次は #31 やる？」のような）に言い換えて、バブルの本文をそれにする。元の本文は消えず、一言の横の「詳細」で今までどおり Markdown で開ける。自分の入力と待ちバブルは変えない。一覧の「最後の発言」も一言があればそれになる。

- **作るのは LLM**で、返信と同じ `claude` CLI を `claude -p --model haiku --output-format json` で叩く（`SAI_CLAUDE_BIN` も効く。モデルは `SAI_DIGEST_MODEL` で変えられる）。結果は `~/.agent-feed/digest.jsonl` に追記する。JSONL（記録）は触らず、派生データなので消しても履歴は壊れない
- **既定はオフ。** トークンと時間を使うのと、本文を LLM に送るので、黙って走らせない。オンにしても**サーバが起動したあとに増えた行**だけ作る（過去の行は作らない）。ヘッダの「直近20件に一言」で、まだ無い直近 20 件だけ積める
- 1 行ずつ直列で回す。失敗した行（`claude` が無い、ログインしていない、90 秒で終わらない）は一言無しのままで、画面は本文を出す。理由は `~/.agent-feed/digest.log` に残る
- 一言を作る `claude -p` が自分自身を記録しないよう、その子プロセスには `AGENT_FEED_SKIP=1` を渡す（`record.py` はこれが立っていると何も書かない）。`--bare` は OAuth を読まないので使えない。フックが指す `record.py` が古くてこれを知らない間は子のターンが JSONL に書かれてしまうが、子は `~/.agent-feed` を `cwd` にして起動するので、サーバは **`cwd` がそこの行を SAI 自身の雑音として読み飛ばす**（画面に出ず、要約もしない）。フックの checkout を最新にすれば書かれなくなる
- **性格は MBTI の 16 タイプから**ヘッダの select で選ぶ（性格なしも選べる）。口調の指示だけが変わり、中身（何をしたか）は変えない。サーバが作るので設定はサーバ側（`~/.agent-feed/settings.json`、`GET/PUT /api/settings`）にあり、変えると**以後の行から**効く。過去の一言は作ったときの性格のまま。MBTI は口調の「型」として借りるだけで、診断や性格分析の話にはしない。口調の表は `shared/persona.ts`

### エンドポイント

| | |
| --- | --- |
| `GET /` | ビューア（`web/dist/index.html`） |
| `GET /assets/*` | ビルド成果物。`dist/` の外には出ない |
| `GET /api/sessions?days=7&repo=&agent=&date=&archived=` | セッション一覧（集計済み）。`record_version` は窓の中の一番新しい行の `v`（画面の「record.py が古い」の判定）。各セッションの `waiting` は人を待って止まっていれば「何を待っているか」、そうでなければ空。`filters` に絞り込み候補、`replying` に処理中の返信（ID → `{ since, text }`）、`approvals` に返信中のエージェントが待っている許可・質問（ID → 古い順の配列）、`profile` に自分の表示名とアイコンも返す。既定ではアーカイブ済みを除き、`archived=1` でアーカイブ済みだけ（`total` と `filters` もその集合から）。`viewer` は tailnet 経由ならログイン名、直アクセスなら `null` |
| `GET /api/health` | `{ ok: true, viewer }`。認証の確認にも使う（偽ヘッダで `401` になること） |
| `GET /api/sessions/<id>?days=30` | そのエンティティの全行と `replying`。`<id>` は `<セッション>@<リポジトリ>` |
| `POST /api/sessions/<id>/reply?days=90` | body `{ "text": "..." }`。そのセッションを `cwd` で再開して1ターン回すのを投げっぱなしにし、`202` を返す。合成 ID は `400`、進行中は `409`、別オリジンは `403` |
| `POST /api/approvals` | 返信中の CLI（`server/approve-mcp.ts`）が許可・質問を預ける。body `{ "id", "tool_name", "input", "tool_use_id"? }`。返信を処理中でないエンティティは `409`。`201` で `{ "approval_id" }` |
| `GET /api/approvals/<approval_id>?wait=1` | 答えが付いていれば `200` で `{ "behavior": "allow" \| "deny", "updatedInput"?, "message"? }`（渡したら消える）。まだなら `wait=1` で最大 20 秒待って `202`。無ければ `404` |
| `POST /api/approvals/<approval_id>/answer` | 画面から答える。body `{ "behavior": "allow" \| "deny", "updatedInput"?, "message"? }`。`allow` で `updatedInput` を省けば元の入力のまま。別オリジンは `403`、答え済みは `404` |
| `GET /api/sessions/<id>/meta` | 表示名・アーカイブ。`{ "id", "meta": { "name"?, "archived_at"? } }`。無ければ `meta` は `{}` |
| `PUT /api/sessions/<id>/meta?days=90` | body `{ "name"?: "...", "archived_at"?: "<ISO>", "model"?: "opus" }` をいまの値に重ねる。省略したキーは据え置き、空文字や `null` は「消す」で、全部消えたらエントリごと消える。知らないキーは捨てる。名前は100文字まで、`archived_at` は読める時刻、`model` は英数字で始まる 64 文字までの名前（違えば `400`）。窓の中に無いセッションは `404`、別オリジンは `403` |
| `GET /api/sessions/<id>/icon?v=<mtime>` | アイコン画像そのもの（`image/png` など）。無ければ `404`。`v` がいまのファイルと同じなら `Cache-Control: immutable`、無ければ `no-store` |
| `PUT /api/sessions/<id>/icon?days=90` | body は画像そのもの（PNG / JPEG / GIF / WebP、1MB まで。種類は中身で見る。画面からは加工後の 256px の PNG が来る）。`{ "id", "icon": "<URL>" }` を返す。画像でなければ `400`、大きすぎれば `413`、窓の中に無いセッションは `404`、別オリジンは `403` |
| `DELETE /api/sessions/<id>/icon` | 画像を消す。`{ "id", "icon": null }`。無くても `200`。別オリジンは `403` |
| `GET /api/profile` | 自分の表示名とアイコン。`{ "profile": { "name"?, "icon"? } }`。`icon` は `/api/profile/icon?v=<mtime>` |
| `PUT /api/profile` | body `{ "name"?: "..." }` をいまの値に重ねる。空文字や `null` は「消す」。100文字まで（超えたら `400`）。別オリジンは `403` |
| `GET /api/profile/icon?v=<mtime>` | 自分のアイコン画像そのもの。無ければ `404`。キャッシュの扱いはセッションのアイコンと同じ |
| `PUT /api/profile/icon` / `DELETE /api/profile/icon` | 画像を置く / 消す（受け付ける種類・上限はセッションのアイコンと同じ）。`{ "profile": … }` を返す。別オリジンは `403` |
| `GET /api/settings` | サーバ側の設定。`{ "persona", "digest", "model" }`。`digest` は一言の配線が有効か（`SAI_DIGEST=1`） |
| `PUT /api/settings` | body `{ "persona": "ENFP" }` で性格を変える。`shared/persona.ts` に無い値は `400`、別オリジンは `403` |
| `POST /api/digest/backfill?n=20&days=7` | まだ一言が無い直近 `n` 件を作る列に積む。`{ "queued" }` を `202` で返す。無効なら `400`、別オリジンは `403` |
| `GET /api/feed?days=3&repo=` | 生の行と `replying`。アーカイブ済みセッションの行は除く |

返信の実行は `server/runner.ts`。`claude` / `codex` は `detached` で起動して待たず、stdout/stderr は `~/.agent-feed/reply.log` に追記する（うまく動かないときはここを見る）。同じエンティティに同時に2本は走らせない。

集計はサーバ側（`server/aggregate.ts`）。エンティティのキー（`<セッション>@<リポジトリ>`、セッションが取れない行は `unknown-<日付>`）は `shared/entity.ts` にあり、サーバの集計と画面のリンクが同じ関数を使う。ファイルは `(mtime, size)` で覚えていて、変わっていなければ再パースしない（`server/store.ts`）。1日開きっぱなしにしても重くならないのはこのため。

レスポンスの形は `shared/types.ts` に1つだけ書いてあり、サーバの集計と画面の受け取りが同じ型を見る。フィールドを足すときはそこに足すと、片方だけ忘れたときに `pnpm typecheck` で止まる。

## 守ること

- **`record.py` は絶対に失敗しない。** 必ず exit 0。フックが落ちるとエージェント本体を止めてしまうので、記録に失敗しても黙って諦める。何が起きたか見たいときは `AGENT_FEED_DEBUG=1` で `~/.agent-feed/record-errors.log` に残る。15秒で自分を殺す保険も入っている
- **本物の Slack には投げない。** 投げ先が会社のワークスペースになるので、個人リポジトリのセッション記録がそこに流れるのは避ける
- **SAI は外に出さない。** `127.0.0.1` 限定。デプロイもホスティングもしない。中身は作業内容そのもの。出してよいのは **tailnet まで**で、それも `tailscale serve`（前段のプロキシ）経由だけ。アプリ自身の bind は変えないし、`tailscale funnel` は使わない。Serve のヘッダは `whois` で突き合わせ、合わなければ `401`
- **ブラウザからコマンドが走る。** 返信は `claude` / `codex` を任意の `cwd` で起動する。ローカルで開いている別サイトからの CSRF でエージェントを走らせないよう、`POST` は `Origin` / `Sec-Fetch-Site` が同一オリジンでなければ `403`（どちらも無い curl などブラウザ以外は通す）。この確認は外さない。権限のバイパス（`--dangerously-skip-permissions` など）も付けない
- **一言（digest）は本文を LLM に送る。** `SAI_DIGEST=1` のときだけで、既定はオフ。返信と同じ `claude` CLI 経由だが、仕事のリポジトリの返答をそのまま要約に出すことになるのは分かって使う
- **一覧のタイトルに機密が乗りうる。** 仕事のリポジトリのセッションだと issue の内容がそのまま出る。スクリーンショットを撮るときは自分で気をつける

## 環境変数

| | |
| --- | --- |
| `SAI_HOME` | このリポジトリの場所。上のフック設定例が `$SAI_HOME/feed/record.py` として使う（`record.py` やサーバ自身は読まない） |
| `AGENT_FEED_DIR` | 出力先（既定 `~/.agent-feed`）。`record.py` とサーバの両方が見る |
| `AGENT_FEED_DEBUG` | `1` で `record.py` の例外をログに残す |
| `CODEX_HOME` | Codex のホーム（既定 `~/.codex`） |
| `SAI_PORT` | サーバの既定ポート（既定 `8787`） |
| `SAI_TERMINAL` | `0` で「tmux のペインに打ち込む」を切り、返信を常に別プロセスで回す |
| `SAI_TMUX_BIN` | ペインに打ち込むときの `tmux` の実行ファイル（既定は PATH の `tmux`） |
| `SAI_CLAUDE_BIN` | 返信で起動する `claude` の実行ファイル（既定は PATH の `claude`）。launchd などで PATH が最小のときに |
| `SAI_CODEX_BIN` | 同じく `codex` |
| `SAI_CLAUDE_ARGS` | 返信の `claude -p --resume` に足す引数。空白区切りで、空白を含む値は `"…"` か `'…'` で囲む。例: `--allowedTools "Bash(gh *)"`、`--permission-mode acceptEdits`。「返信と許可」の項を読んでから |
| `SAI_TAILSCALE_BIN` | tailnet 経由の認証で `whois` に使う `tailscale` の実行ファイル（既定は PATH、無ければ macOS の GUI 版） |
| `SAI_CODEX_ARGS` | 同じく `codex exec resume` に足す引数。例: `-s workspace-write` |
| `AGENT_FEED_SKIP` | `1` なら `record.py` は何も記録しない。SAI が一言を作るために回す `claude -p` に付ける（自分自身を記録しない） |
| `SAI_DIGEST` | `1` で一言コメント（digest）を作る。既定はオフ |
| `SAI_DIGEST_MODEL` | 一言を作るモデル（既定 `haiku`）。`claude -p --model` にそのまま渡す |
| `SAI_APPROVE` | `0` で「返信中の許可・質問に画面から答える」配線（`--mcp-config` + `--permission-prompt-tool`）を付けない |
