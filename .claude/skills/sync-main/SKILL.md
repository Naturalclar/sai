---
name: sync-main
description: main worktree を最新の main に進めて web/dist/ をビルドし直し、古いコードで動いているサーバを一言（digest）付きで立て直す。cwd がどの worktree でも main worktree だけを触る。`/merge` の後始末からも呼ばれる。ユーザーが「最新をpullしてビルドして」「mainを最新にして」「main worktree を更新して」「pull the latest main and build」「sync main」と言ったときに使う。
---

# sync-main

main worktree の更新、ビルド、必要なサーバ再起動は `sync.sh` がまとめて行う。エージェントが個々の `git` / `pnpm` / `lsof` / `ps` / `curl` / `tmux` を順番に呼ばない。

## 実行

今いるリポジトリのルートを渡して、次の **1 回だけ**を実行する。最長8分lockを待つので、コマンドのタイムアウトは10分以上にする。

```sh
root=$(git rev-parse --show-toplevel)
bash "$root/.claude/skills/sync-main/sync.sh" "$root"
```

スクリプトは短い `key=value` の行だけを返す。

- `main=`: 操作対象のmain worktree
- `lock=`: `acquired waited=Ns`。最後の `lock=released` まで出れば解放済み
- `sync=updated commits=...` / `sync=latest`: 取り込んだコミット、または既に最新
- `build=ok`: install・typecheck・build成功
- `server=`: `restarted` / `latest` / `watch` / `stopped` / `deferred` / `blocked`
- `digest=`: 入切・口・モデル・エラー。切なら、ローカルの `qwen3:8b` があればopenai、無ければclaudeに設定する
- `verify=build-yes`: `X-SAI-Build` と `web/dist/index.html` が一致
- `status=ok` / `status=blocked stage=...`: 全体の結果

## 結果の扱い

- `status=ok`: そのまま報告する。`server=stopped` は人が止めている意図を守って起動していない
- `server=deferred ... reason=codex-busy`: mainとbuildは更新済み。`/merge` の後始末なら待たず、「Codexのターンが回っているため再起動していない。終わったら `/sync-main`」と報告する。人が直接頼んだ実行なら、終わったあとこのスキルをもう一度呼べる
- `server=blocked`: mainとbuildは更新済みだが、安全に再起動・検証できなかった。`reason`をそのまま報告し、手作業でC-cやkillを足さない
- `status=blocked`: `stage`と`detail`を報告して止める。dirty、main worktree不在、ff不可、install/build失敗を勝手にreset・checkout・stashで直さない
- 終了コード3: 他の同期がlockを持ったまま待ち切れなかった。lockを消さず持ち主を報告する

## スクリプトが守ること

- mainブランチのworktreeだけを触り、cleanでなければfetch前に止まる。取り込みは`FETCH_HEAD`への`--ff-only`だけ
- 共通gitディレクトリのlockを取り、成功・失敗・シグナルのどの出口でも自分のlockだけを解放する
- サーバが止まっていれば起動しない。`node --watch`ならC-cしない
- 通常のサーバを再起動するのは、`server/`か`shared/`が起動時刻より新しく、SAIのapp-serverが回すCodexターンが無く、同じtmuxペインを引けたときだけ
- 再起動は同じペインで C-c → シェルの子が消えるまで待つ → C-u → `pnpm start`。新しいpidが同じシェルの子でなければ、それ以上触らない
- `kill`・`reset`・`checkout`・`stash`、tailscale serveの操作はしない。一言が既に入なら設定を変えない

## 報告

- 入ったコミット（無ければ「最新でした」）とビルド結果
- サーバを再起動したか。しなかった場合は `server=` の理由
- `digest=` と `verify=` の結果（出ている場合）
- lockを待った場合は `waited=` の秒数
