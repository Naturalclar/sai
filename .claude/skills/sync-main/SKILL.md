---
name: sync-main
description: main worktree を最新の main に進めて web/dist/ をビルドし直し、古いコードで動いているサーバを一言（digest）付きで立て直す。cwd がどの worktree でも main worktree だけを触る。ユーザーが「最新をpullしてビルドして」「mainを最新にして」「main worktree を更新して」「pull the latest main and build」「sync main」と言ったときに使う。
---

# sync-main

main worktree を最新の `main` に進めて `web/dist/` を作り直し、サーバがそれで動いているところまで確かめる。
やるのは fetch → ff-only merge → install → build → サーバを最新のコードにする → 報告。**main worktree の状態は壊さない**（reset / checkout / stash はしない）。

セッションは `dev-*` のような別の worktree から呼ばれることが多い。cwd は動かさず、`git -C "$main"` / `pnpm -C "$main"` で main worktree を操作する。

## 0. main worktree を見つける

```sh
main=$(git worktree list --porcelain | awk '/^worktree /{w=$2} /^branch refs\/heads\/main$/{print w}')
[ -n "$main" ] || main=$(git rev-parse --show-toplevel)   # worktree を使っていない普通の clone
echo "$main"
```

`main` ブランチに乗っている worktree が 1 つも無ければ止めて、`git worktree list` の一覧を添えて報告する（main worktree で枝を切って作業中、ということがある。勝手に `main` に戻さない）。

## 1. 更新してよい状態か

```sh
git -C "$main" status --short             # 空でなければ止める（誰かがそこで作業中）
git -C "$main" branch --show-current      # main でなければ止める
```

どちらかで止めたら、理由と `status` の中身を報告して終わり。

## 2. 取り込む

bare repo + worktree の構成では `origin/*` の追跡 ref が無い（refspec 無し）。`origin/main` ではなく **`FETCH_HEAD`** を使う。

```sh
git -C "$main" fetch origin main
git -C "$main" log --oneline HEAD..FETCH_HEAD     # 何が入るか。空なら「最新です」。ビルドは 4 の確認だけして終わる
git -C "$main" merge --ff-only FETCH_HEAD          # ff できなければ止める（main に直接コミットがある）
```

入るコミットの一覧は報告に使うので控えておく。

## 3. ビルド

Node は `package.json` の `engines`（22.18+）。asdf の環境では版を渡さないと古い Node が選ばれ、`pnpm build` / `pnpm start` が `ERR_UNKNOWN_FILE_EXTENSION` で落ちる。

```sh
node -v                                   # 22.18 未満なら ASDF_NODEJS_VERSION=22.x を付けてやり直す
pnpm -C "$main" install --frozen-lockfile  # lockfile が変わっていなくても速いので毎回
pnpm -C "$main" build                      # typecheck 込み。落ちたらここで止めて出力をそのまま出す
```

## 4. サーバを最新のコードにする

```sh
pid=$(lsof -nP -iTCP:8787 -sTCP:LISTEN -t)    # ポートは SAI_PORT / --port で変わる
```

**動いていなければ起動しない。** 「起動していない」と報告して、下の起動コマンドを添えるだけにする（止めてあるのはその人の意図かもしれない）。

### 立て直しが要るか

`pnpm start` は `server/` が変わっても再起動しない。**今回の sync だけでなく、前回の sync のあと立て直さないままのことがある**（実際に 2 回続けて、1 時間前のコードのサーバが動いていた）。`before..HEAD` の差分ではなく、**プロセスの起動時刻より新しいファイルがあるか**で見ると、どちらの場合も拾える（merge / checkout は変わったファイルの mtime だけ更新する）。

```sh
started=$(date -j -f '%c' "$(ps -o lstart= -p "$pid")" +%s)      # macOS
ref=$(mktemp); touch -t "$(date -r $started +%Y%m%d%H%M.%S)" "$ref"
find "$main/server" "$main/shared" -name '*.ts' -newer "$ref"; rm -f "$ref"
```

何も出なければサーバは最新のコード。立て直さず 5 に進む。

`pnpm start:watch`（`node --watch`）で動いていれば自分で再起動するので **C-c は送らない**。ただし**処理中の返信（`claude -p --resume`）があると `Waiting for graceful termination...` でその終了を待つ**ので、listen が無い時間が数十秒ある。

### 一言（digest）の口を決める

既定はローカルの Ollama（本文が手元から出ない。`claude` の usage も使わない）。**モデルがあるかを先に見る**。無い口を指定すると、サーバは立つが一言が 1 つも付かず、`~/.agent-feed/digest.log` にモデルのエラーが並ぶだけになる。

```sh
curl -sS -m 5 http://127.0.0.1:11434/v1/models    # qwen3:8b が居るか
```

| 状況 | 起動コマンド |
| --- | --- |
| Ollama に `qwen3:8b` が居る（既定） | `SAI_DIGEST=1 SAI_DIGEST_PROVIDER=openai SAI_DIGEST_MODEL=qwen3:8b pnpm start` |
| Ollama が居ない / モデルが無い | `SAI_DIGEST=1 pnpm start`（`claude -p --model haiku`。usage を使うことを報告に書く） |

`SAI_DIGEST_PROVIDER=claude` に `SAI_DIGEST_MODEL=qwen3:8b` を渡してはいけない。`claude` CLI は Anthropic のモデル名しか受けず、`There's an issue with the selected model` が並ぶだけになる。ローカルのモデルは `openai` の口とだけ組む。

### サーバが居るペインで立て直す

サーバは人が開いた tmux のペインで動いている。**そのペインで立て直す**（別の場所で `spawn` すると、その人の画面からログが見えなくなる）。ペインは listen している pid の tty から引く:

```sh
tty=$(ps -o tty= -p "$pid" | tr -d ' ')
pane=$(tmux list-panes -a -F '#{pane_id} #{pane_tty}' | awk -v t="/dev/$tty" '$2==t{print $1}')
tmux send-keys -t "$pane" C-c
# 港が空くまで待つ。foreground の sleep は使えないので until で回す
i=0; until [ -z "$(lsof -nP -iTCP:8787 -sTCP:LISTEN -t)" ] || [ $i -gt 3000000 ]; do i=$((i+1)); done
tmux send-keys -t "$pane" 'SAI_DIGEST=1 SAI_DIGEST_PROVIDER=openai SAI_DIGEST_MODEL=qwen3:8b pnpm start' Enter
i=0; until [ -n "$(lsof -nP -iTCP:8787 -sTCP:LISTEN -t)" ] || [ $i -gt 3000000 ]; do i=$((i+1)); done
tmux capture-pane -p -t "$pane" | grep -v '^\s*$' | tail -3
```

ペインが引けなければ（tmux の外で動いている）立て直さず、「このコマンドで立て直してください」と報告する。

### 確かめる

```sh
curl -sS -m 10 http://127.0.0.1:8787/api/settings                  # digest / provider / model
curl -sS -m 10 -D - -o /dev/null 'http://127.0.0.1:8787/api/sessions?days=1' | grep -i x-sai-build
stat -f '%m' "$main/web/dist/index.html"                            # 上の X-SAI-Build と一致すること
```

起動時のログに `digest: openai http://127.0.0.1:11434/v1 model=qwen3:8b` が出る。`X-SAI-Build` が `dist/index.html` の更新時刻と一致していれば、開いているタブは `watchBuild` が自分で再読み込みする（#87 の「ビルドが古い」バナーもそれで消える）。

一言は**サーバの起動時刻より後の行**だけ作る（#164）。窓の広さで基準が変わることはもう無いので、`days` を先回りして叩くような小細工は要らない。

## 5. 報告

- 入ったコミットの一覧（`HEAD..FETCH_HEAD` の 1 行ずつ）。無ければ「最新でした」
- ビルドの結果
- サーバを立て直したか（立て直したなら、どのコマンドで・一言の口はどちらか）。立て直していないならその理由（最新のコードだった / 起動していない / tmux の外）。`/api/settings` の中身を一言
- 止めた場合はその理由（dirty、別ブランチ、ff 不可、ビルド失敗）と、人が何をすれば進むか

## やらないこと

- `git reset` / `git checkout` / `git stash`。stash は他のセッションと共有なので特に触らない
- 止まっているサーバを起動すること（立て直すのは、動いていて古いコードのときだけ）
- Ollama の起動・モデルの pull（無ければ `claude` の口に落として報告する）
- 他の worktree（`dev-*`）の更新。それは各セッションが自分でやる
- tailscale serve の操作（`tailscale-serve` スキルが別にある）
