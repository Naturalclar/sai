---
name: sync-main
description: main worktree を最新の main に進めて web/dist/ をビルドし直し、動いているサーバが追従したかまで確かめる。cwd がどの worktree でも main worktree だけを触る。ユーザーが「最新をpullしてビルドして」「mainを最新にして」「main worktree を更新して」「pull the latest main and build」「sync main」と言ったときに使う。
---

# sync-main

main worktree を最新の `main` に進めて `web/dist/` を作り直し、サーバがそれで動いているところまで確かめる。
やるのは fetch → ff-only merge → install → build → 追従の確認 → 報告。**main worktree の状態は壊さない**（reset / checkout / stash はしない）。

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

## 4. サーバが追従したか

```sh
lsof -nP -iTCP:8787 -sTCP:LISTEN          # ポートは SAI_PORT / --port で変えられる。動いていなければ「起動していない」で終わり
```

- **起動はしない。** `SAI_DIGEST=1` のような環境変数はその人の選択なので、勝手に決めて立てない。動いていなければそう報告する
- `pnpm start:watch`（`node --watch`）なら `server/` `shared/` の変更で自動再起動する。ただし**処理中の返信（`claude -p --resume`）があると `Waiting for graceful termination...` でその終了を待つ**ので、listen が無い時間が数十秒ある。`sleep` は使えないので、`until lsof …; do :; done` の形で上限付きに待つ
- 素の `pnpm start` は再起動しない。`server/` か `shared/` に変更が入っていたら「再起動が要る」と報告する（`git -C "$main" diff --stat <前のHEAD> HEAD -- server shared`）
- 画面は `X-SAI-Build`（`web/dist/index.html` の mtime）で追従する。一致していれば開いているタブは `watchBuild` が自動で再読み込みし、「ビルドが古い」のバナーも消える:

```sh
curl -sS -m 10 -D - -o /dev/null 'http://127.0.0.1:8787/api/sessions?days=1' | grep -i x-sai-build
stat -f '%m' "$main/web/dist/index.html"     # macOS。Linux は stat -c '%Y'
curl -sS -m 10 http://127.0.0.1:8787/api/settings   # digest / persona / model。環境変数が引き継がれているかの確認
```

## 5. 報告

- 入ったコミットの一覧（`HEAD..FETCH_HEAD` の 1 行ずつ）。無ければ「最新でした」
- ビルドの結果
- サーバが新しいコードで動いているか。`start:watch` で再起動を待ったならそのこと、`pnpm start` なら再起動が要るか。`/api/settings` の中身を一言
- 止めた場合はその理由（dirty、別ブランチ、ff 不可、ビルド失敗）と、人が何をすれば進むか

## やらないこと

- `git reset` / `git checkout` / `git stash`。stash は他のセッションと共有なので特に触らない
- サーバの起動、環境変数の変更
- 他の worktree（`dev-*`）の更新。それは各セッションが自分でやる
- tailscale serve の操作（`tailscale-serve` スキルが別にある）
