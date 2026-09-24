---
name: merge
description: PR をマージする前に、書いた本人とは別の目で 1 回レビューし、直したうえで結果を PR のコメントに残してから squash マージする。ユーザーが「マージして」「マージしてよい」「PR をマージして」「merge the PR」「merge it」と言ったときに使う。このリポジトリの PR だけに使う。
---

# merge

**書いた本人以外の目を一度も通さずに `main` に入れない**、が目的（#449）。

実測（2026-09-02〜09-16 の 15 日）でマージした PR は 210 本、直近 60 本の**レビューもコメントも 0 件**、PR を開いてからマージまでの中央値は 8 分だった。門は「CI が緑」と人の「マージして」だけで、**何を見て通したか**は記録に残っていない。題名に「直す」が付く PR が 8.5%、revert が 1 本。

やるのは 対象を決める → 状態を見る → **別の文脈でレビュー** → 直す → **PR にコメント** → squash マージ → 後始末。

## 0. リポジトリと PR を決める

owner/repo は**ハードコードしない**（間違ったリポジトリを見ても `gh` はエラーにならず、ただ 0 件を返す）。

```sh
repo=$(git remote get-url origin | sed -E 's#^[^@]*@[^:/]+[:/]##; s#^[a-z]+://[^/]+/##; s#\.git$##')
echo "$repo"
```

番号を言われていればそれを `pr` に入れる。言われていなければ**いまのブランチの PR**を引く。**`--repo` を付けたら位置引数が要る**（`gh pr view --repo … --json …` だけだと `argument required when using the --repo flag` で必ず落ちる）:

```sh
pr=$(gh pr view "$(git branch --show-current)" --repo "$repo" --json number -q .number)
```

引けなければ `gh pr list --repo "$repo" --state open` を見せて、**どれかを人に選ばせる**（勝手に 1 本目を選ばない）。以降で使う値をここで揃えておく:

```sh
head=$(gh api "repos/$repo/pulls/$pr" -q .head.ref)
echo "pr=$pr head=$head"
```

## 1. マージしてよい状態か

```sh
gh pr checks "$pr" --repo "$repo" --watch --fail-fast   # 終わるまで待つ。赤ければすぐ返る
gh api "repos/$repo/pulls/$pr" -q '.state + " / base=" + .base.ref + " / mergeable=" + (.mergeable|tostring) + " / " + .mergeable_state + " / draft=" + (.draft|tostring)'
```

- **`until gh pr checks …; do …; done` のような回し方はしない。** `gh pr checks` は **pending でも fail でも非 0** を返すので、赤いまま永久に回る。待つのは `--watch`（`--fail-fast` で赤ければ即終了）
- **`mergeable` が `null`（`mergeable_state: unknown`）は「まだ計算していない」**で、「コンフリクトしていない」ではない。PR を作った直後は必ずこれになるので、**`null` でなくなるまで読み直す**:

```sh
for _ in 1 2 3 4 5; do
  m=$(gh api "repos/$repo/pulls/$pr" -q '(.mergeable|tostring) + " " + .mergeable_state')
  case "$m" in null*) sleep 2;; *) break;; esac
done
echo "$m"
```

止める条件（理由を添えて報告し、マージしない）:

- CI が 1 つでも `fail`
- `base.ref` が `main` でない（#6 がこれでマージ済みの作業ブランチに入り、`main` に届かなかった）。付け替えは `gh api -X PATCH "repos/$repo/pulls/$pr" -f base=main`
- `draft: true`
- `mergeable: false`（`mergeable_state: dirty` = コンフリクト）。**直しにかかる前に**、その issue を閉じたコミットが既に `main` に入っていないかを見る（**`FETCH_HEAD` は bare clone の全 worktree で共有される古い値なので、必ず自分で fetch してから**）:

```sh
git fetch origin main
git log --oneline HEAD..FETCH_HEAD
```

入っていれば、直すのではなく **PR を閉じる**。

**既知の flake で赤いときだけ**、1 回だけ回し直してよい（例: #424 = `turnUsage` のテストがミリ秒の境目で落ちる。#453 で直したので、これ自体はもう鳴らない）。**回し直しても赤ければ止める**。回し直したことと、どの issue の flake かは 4 のコメントに書く。**flake だと思った、で通さない**（同じ落ち方が既に issue になっていることを確かめる）。

**回し直すのは「いまの HEAD の run」だけ。** `.github/workflows/ci.yml` は `concurrency: cancel-in-progress` を ref ごとに掛けているので、**古いコミットの run を rerun すると、同じブランチのいまの run が cancel される**（実測: 直したものを push したあと、前の run を `--failed` で回し直したら、新しい方の 3 ジョブが全部 `cancelled` になり、`gh pr checks` にはただ `fail` と出た）。番号は SHA で選ぶ:

```sh
run=$(gh run list --repo "$repo" --branch "$head" --limit 10 \
      --json databaseId,headSha -q "[.[] | select(.headSha == \"$(git rev-parse HEAD)\")][0].databaseId")
gh run rerun --repo "$repo" "$run" --failed
```

**`cancelled` を `fail` と読み違えない**（`gh pr checks` はどちらも `fail` に見せる）。`gh run list` の `conclusion` で確かめる。

## 2. 別の目でレビューする

**同じ文脈で自分の差分を読み直しても、見落としは同じところで起きる。** 新しい文脈で読ませる。

```
/code-review <PR 番号> medium
```

- `/code-review` は**別プロセスに fork して**動くので、これ自体が「新しい目」になる（結果だけが戻る）
- 効果の強さは `low` / `medium`（**確度の高いものだけ**）から。`high` 以上は当たりも増えるが不確かなものも混ざるので、量が多い PR のときだけ
- スキルが使えない環境では、代わりに**サブエージェント**に「この差分を読んで、壊れるところだけ挙げて」と投げる（Task / Agent。**自分で読み直すのは代わりにならない**）
- #403 の Codex `review/start`（差分ビューアの「レビューさせる」）でもよいが、**まず Claude 側で回す**（「マージして」の 1 ターンに収まり、人の手順が増えない）

## 3. 指摘を直す

**コメントより先に直す**（コメントには「何を言われて、どうしたか」を一緒に書くので、直す前に書くと嘘になる）。

- **正しい指摘は直してからマージする。** 直したら `pnpm test && pnpm test:feed && pnpm lint && pnpm typecheck` を回し、push して**CI をもう一度待つ**（1 に戻る）
- 直さないと決めたものは**理由を控えておく**（範囲外・別 issue に分けた・誤検出、など）。別 issue に分けたなら番号も
- 直しが大きい（別の設計になる・他のファイルに波及する）ときは、**マージせずに人に戻す**。指摘とそのまま貼れる選択肢を出して止まる

## 4. 結果を PR のコメントに残す

**指摘が 0 件でも必ず 1 行残す。** 残さないと「レビューしたが何も無かった」と「レビューしていない」が後から区別できない。**日付は打たずに `date` から取る**（手で書くと古い日付のまま残る）。

```sh
gh pr comment "$pr" --repo "$repo" --body "レビュー: 指摘なし（claude-opus-5 / medium、$(date +%F)）"
```

指摘があったときは、1 件ごとに **`file:line` / 何が壊れるか / どうしたか** を書く:

```sh
gh pr comment "$pr" --repo "$repo" --body-file - <<EOF
## レビュー（claude-opus-5 / medium、$(date +%F)）

7 件の指摘、6 件を直して 1 件を見送り。

- \`server/app.ts:461\` — 同じ cwd に会話が 2 本あると別のペインに打ち込む → **直した**（$(git rev-parse --short HEAD)）
- \`web/src/usageLabel.ts:26\` — \`1 分 60 秒\` になる → **見送り**: この PR の範囲外。#436 に分けた
EOF
```

## 5. マージする

**レビューした SHA を指定してマージする。**

```sh
sha=$(gh api "repos/$repo/pulls/$pr" -q .head.sha)   # 2 で読んだ HEAD と同じか確かめる
gh api -X PUT "repos/$repo/pulls/$pr/merge" -f merge_method=squash -f sha="$sha"
```

`main` は PR 1 本 = コミット 1 つにする（squash 以外は使わない）。

**`gh pr merge` の素の形は使わない**（`-f sha=` を渡せない）。2〜4 の間に**別のセッションが同じブランチへ push する**と、読んでいないコミットがそのまま `main` に入る——このリポジトリは worktree ごとに並行してセッションが動いているので、実際に起こりうる。`sha` を渡しておけば HEAD が動いていた場合は GitHub が `405`（`Head branch was modified`）で弾くので、**「レビュー後に動いていたら止まる」が手順ではなく仕組みで担保される**。弾かれたら 1 に戻る（増えた分も読む）。

## 6. 後始末

**マージできたことを確かめてからブランチを消す**（失敗したまま消すと PR が閉じて reopen できない）。

```sh
gh api "repos/$repo/pulls/$pr" -q '"merged: " + (.merged|tostring) + "  " + (.merge_commit_sha // "-")[0:7]'
```

`merged: true` を見てから:

```sh
git push origin --delete "$head"
```

## 7. 報告

- マージしたコミット（`<sha> <題名> (#<番号>)`）と CI の結果
- **レビューで何件出て、何件直して、何件を理由つきで見送ったか**（0 件なら「指摘なし」とはっきり書く）
- 止めたならその理由と、人が何をすれば進むか

## やらないこと

- **レビューを飛ばしてマージする。** 人が「マージして」としか言っていなくても、間に 2〜4 を挟む（それがこのスキルの全部）
- CI の `pending` を「たぶん通る」で通すこと。既知の flake の回し直しは 1 回まで
- squash 以外のマージ、`--admin` での強制マージ
- `merged: true` を確かめる前にブランチを消すこと
- 自分のレビューを自分で「指摘なし」と書くこと（**別の文脈で読ませた結果**だけをコメントにする）
- 人のレビューを要求する・branch protection を触ること（レビューできるアカウントが 1 つしか無い。#449 の「やらないこと」）
