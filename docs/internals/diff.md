# 差分と PRの仕組み

CLAUDE.md から移した「どう動くか」。守る決まりは CLAUDE.md、経緯は [history/diff.md](../history/diff.md)。

見え方（何が出るか・いつ閉じるか・上限）は [screen.md の「変更内容の diff を見る」](../screen.md#変更内容の-diff-を見る) と「GitHub の PR を見る」、口の形は [api.md](../api.md) の `/diff`・`/review`・`/api/prs`。ここにはコードの側の話を置く。

## 差分ビューア

- `GET /api/sessions/<id>/diff` は `server/git/diff.ts` がセッションの `cwd` で git を読む（#171）。`base...HEAD`（ブランチの差分）と `HEAD` からの未コミット、追跡外のファイル名。
- base を探す順と「`origin/<x>` と `<x>` が両方あれば新しい方」（#289）は screen.md のとおり。新しい方の判定は `merge-base --is-ancestor` で、同じコミットか分岐なら `origin/<x>`。
- 読むだけのサブコマンドしか呼ばない: `RealGit.run()` が allowlist で弾く。
- 上限は 1 ファイル 200KB / 1 セクション 2MB で、超えたら本文を落として `truncated`（ファイルの一覧は常に全部返す）。
- unified diff を木にするのは `shared/diff.ts` の `parseUnifiedDiff()`（`shared/diff.test.ts`）、描画は `web/src/DiffView.tsx`。
- 3 秒のポーリングには乗せず、`DiffButton` を押したときだけ取る。
- テストは `Git` を差し替えるか、本物の一時リポジトリを作る（`server/git/diff.test.ts`）。

### 画面の枠（#190 / #221 / #514）

- 広い画面はチャットの右にもう1枚のペイン（`DiffPane`。`main.layout.diff-open` の3列目）、狭い画面はモーダル（`DiffModal`）。中身は両方 `DiffBody`。
- 開いている id は `App.tsx` が持ち（`useNarrow()` で出し分け）、そのセッションを開いている間だけ出す。フィードのバブルから開いたものだけはフィードでも出す。規則は `web/src/feedDiff.ts` の `visibleDiff()`。
- 枠は両方とも「流れない見出し（`.diff-head`。題名 + ✕）＋ 流れる中身（`.diff-scroll`）」。モーダル側は `.modal.diff` の `padding` を外して `flex` にしてある（`overflow-y` をモーダル自身に付けると閉じるボタンが差分の一番下まで流れる）。
- 本文の行の箱（`.vlist`）は一番長い行の幅まで伸ばす（幅は DOM ではなく文字数から決める。下の「仮想化」）。そのぶん行のコメントの幅は `.patch` を container にした `100cqw`（見えている幅）で抑える。

### 仮想化（#287）

大きい差分（4,000 行近く）を狭い画面で開くと重かった（差分だけで約 1.7 万要素。時間の大半は layout）ので、**見えている行 ± 余白だけを DOM に置く**。

- 単位は**ファイルごと**（`DiffView` → `DiffFileItem`（`memo`。他のファイルの開閉・編集で描き直さない）→ `DiffFilePatch`）。ファイルの開閉と、ファイルごとの横スクロールの箱（`.patch`）はそのまま。
- 行の高さは固定（`.ln` 18px = 12px × 1.5、`.hh` 20.5px、ハンクの間の罫線 1px）。値は `web/src/diffVirtual.ts` の `LINE_H` / `HUNK_HEADER_H` / `HUNK_GAP` と `styles.css` の両方にあり、変えたら両方。
- 「スクロール位置 → 描く行の範囲」は `diffVirtual.ts` の純粋関数（`layoutFile` / `visibleRange` / `rowsToRender`。`diffVirtual.test.ts`）。上下に `OVERSCAN_PX`（400px）の余白。箱は全行ぶんの高さで、行は `position: absolute`。見えていないファイルは高さだけの空箱。
- **行コメント（#511）が付いている行と編集中の行は、見えていなくても常に置く**（`pinned`）。高さは置いたあとに `ResizeObserver` で測り、その下の行の位置に足す（`rowTop` / `fileHeight` の `extra`）。
- **横幅は DOM からではなく、ファイルの中で一番長い行の文字数から先に計算して固定する**（`fileWidthCells` が行と見出しそれぞれのセル数を出し、CSS の `--cols` / `--hcols` に渡す。全角・絵文字・等幅に無い記号（※ ① ● ─ →）は 2、タブは 8 桁）。px にする計算（1ch × 文字数 + 番号 2 つ + 記号 + 余白）は `styles.css` の `.vlist` の `calc()`（JS で 1ch = 7.2px と決め打つと ch の狭いフォントで足りない。#611）。見えている行だけで `max-content` にすると、一番長い行が画面外に出た瞬間に幅が縮んで横スクロールが跳ねる。
- どこが見えているかは `useScrollTick`（`DiffView` の祖先のスクロール容器の scroll と resize、**根の高さの変化**（上のファイルの開閉で下のファイルがスクロール無しでずれる。#611）を 1 か所で受け、rAF ごとに 1 回購読者に配る）を `ScrollTick` で各ファイルに配り、`DiffFilePatch` が自分の位置を `getBoundingClientRect()` で測り直す。箱ごとの IntersectionObserver も合図。最初の描画でも 1 回測る（空箱の 1 フレームを出さない）。容器は `.diff-scroll`（ペイン / モーダル）でも、PR の画面のように window がスクロールする場合でもよい（`findScroller`）。
- ブラウザのページ内検索（⌘F）は DOM に無い行に当たらず、全部を選んでコピーしても DOM にある行しか入らない。**いったん諦めている**（困ったら差分の中を探す検索欄を別 issue で）。
- 描く範囲は render の中で導く（見えている範囲は ref に持ち、測り直して範囲が変わったときだけ数を進めて描き直す）。ピン留めの高さだけは DOM を描かないと分からないので `useLayoutEffect` で測って state に書く（CLAUDE.md の「effect の中で setState しない」の例外）。
- `.vlist` は `.ln` と同じ 12px の等幅にして `ch` を解決させる。番号の幅はタッチ端末の 4em で数える（広い方。狭く見積もると色が本文の途中で切れる）。コメントの口は `DiffView` がファイルごとに分け、中身が同じなら同じオブジェクトを渡す（`usePerFileComments`。1 件足すたびに全ファイルが描き直らない）。
- タッチ端末で行番号の押せる高さを上下 4px 広げていたのはやめた（行が absolute の兄弟になったので、はみ出した分は隣の行と重なり、後の行が押し勝つ）。幅 4em はそのまま。
- どこまで開くかは `web/src/diffOpen.ts` の `autoOpenPaths()`（上から順に描画行数を積み、`AUTO_OPEN_LINES` = 4000 行の予算まで。`diffOpen.test.ts`）。

## Codex にレビューさせる

- `POST /api/sessions/<id>/review`（同一オリジンのみ）。`CodexApp.review()` が `thread/resume` → `review/start` を投げる。対象は `{ target: { type: 'uncommittedChanges' } }` か `{ type: 'baseBranch', branch }`。`commit` / `custom` は画面から選ぶ材料が無いので出さない。
- 受け取るのは対象の種類だけ。cwd は行から、比べる相手は差分ビューアと同じ `resolveBase()`。決まらなければ 400（見つからないブランチを渡すとターンを 1 本無駄にする）。
- レビューも 1 本のターンなので処理中の歯止めは返信と同じ。預かり（#305）には回さない（預かりが持てるのは本文だけで、レビューの対象を持ち越せない）。
- ほかで開いているスレッドは 400（#430）。判定は返信と同じ `codexHeldElsewhere()` の 1 つ（writer lock を開いているプロセスがいるか、記録時の pid が生きているか）に、端末のペイン（`terminalOf()`）を先に足す。
  - SAI の app-server が握っているもの（`codexApp.holds()`）は自分の持ち物なので除く。
  - 行の `pid` が SAI 自身の app-server（`codexApp.ownPid()`）かその子孫なら、それも数えない（#482）。
- 画面は `DiffBody` が区切りごとに `ReviewButton` を出す（Codex で、いま返信できるセッションだけ。`App` の `canReview`）。
- レビューは Codex が子スレッドを作って走らせるが、`turn/started` / `turn/completed` は親のスレッドに届くので、処理中の扱いも終わりの片付けも普通のターンのままでよい。

## 差分の行へのコメント

- 純粋関数は `web/src/diffComments.ts`（`diffComments.test.ts`）。
- `DiffView` の行番号（`.nos`）を押すと `DiffCommentEditor` が開き、残したものは `useDiffComments()` がセッションごとに localStorage の `sai.diffComments` に持つ。
- `DiffCommentBar` の「入力欄に入れる」が `formatDiffComments()`（区切り → パス → 行の順に、`path:line（追加した行）` とその行の中身の引用とコメント）を `App` の `commentInsert` → `SessionView` → `ReplyBox` の `insert`（`seq` が増えたときだけ、打ちかけの後ろに `appendInsert()` で足す）に流す。
- 差分ビューアから直接は送らない（返信の経路——端末への打ち込みの確認・預かり・失敗したら戻す——を作り直さないため）。
- コメントは行番号に加えて書いたときの行の中身も持つ（`lineAnchor()`。消した行は旧い側、ほかは新しい側）。いまの差分で中身が違えば `commentMoved()` で「行が変わりました」、行ごと見当たらなければ（`commentLine()` が null）差分の上にまとめて出す。
- 書けるのは `App` の `canComment`（そのセッションを開いていて `replyBlockedReason()` が空）のときだけで、フィードから開いた差分には出さない。

## 差分ボタン（#211 / #351）

- `.reply .diff-float` を `position: absolute` で入力欄の上に置く。ヘルプ（`.note`）より上。
- ボタンがある間だけ `.reply` の `margin-top` をボタンの高さぶん広げる（`:has(.diff-float)`。高さは `--diff-float-gap` / `--diff-float-height`）。背景（`--panel`）と影、枠はボタンの大きさだけ（`width: max-content`）。
- 大きさは `?summary=1`（`sessionDiffSummary()`。`--numstat` だけで patch も `--name-status` も呼ばない）から。`web/src/useDiffSummary.ts` がセッションを開いたときと `last_turn_ts` が変わったときだけ取る。
- 数字の丸めと title の組み立ては `web/src/diffCount.ts` の純粋関数（`shortCount` / `hasDiff` / `diffTitle`。`diffCount.test.ts`）。差分が何も無ければボタンを出さない（`hasDiff()`）。
- トグルは `App.tsx` の `toggleDiff`。`ReplyBox` の `diff` prop はセッション画面からしか渡さない。

### フィードのバブル（#280）

- `web/src/feedDiff.ts` の `prStamps()` がターン完了の本文にそのリポジトリの番号（`shared/refs.ts` の `refsIn()`）があるセッションだけを選び、`web/src/useDiffSummaries.ts` がそのセッションの最後のターン完了の `ts` が変わったときだけ `?summary=1` を取る。
- ボタンは `opensDiff()` が本文がいまのブランチの PR（`summary.pr.number`）に触れているバブルだけに出す。
- トグルは「いま出ているか」で決める（`nextDiff()`。セッションで開いたままフィードに来て押しても空振りしない）。
- `feedDiff.test.ts` で回す。

## PR 番号（server/git/pr.ts）

- `PrLookup`。`GhPr` は `gh pr view <branch> --json …` の 1 形だけを組み立てる。`SAI_GH=0` で `NoPr` に差し替わる。
- `gh` が無い・未ログイン・PR 無し・時間切れ（4 秒）は null を返すだけ。cwd はセッションの行から、ブランチは git（`headRef()`。detached なら空で引かない）。同じ (cwd, ブランチ) は 60 秒キャッシュ。
- テストは `PrLookup` を差し替える（`server/diff-summary.test.ts`）ので、ネットワークにも `gh` にも触らない。

## GitHub の PR を読む

- `GET /api/prs` と `/api/prs/<owner>/<repo>/<番号>`、画面は `#/prs` の `PrListView` と `#/pr/<owner>/<repo>/<番号>` の `PrView`。
- `GhPrs` が `gh pr list` / `gh pr list --search review-requested:@me` / `gh pr view` / `gh pr diff` の 4 形と、投稿の口を出すかのための `gh api user` を組み立てる（チェックアウトも fetch もしない）。
- 並べるリポジトリは `shared/prs.ts` の `knownRepos()`（直近 30 日のセッションの remote が GitHub のもの）。URL の `owner/repo` も `pickKnownRepo()` で知っているものから引く。
- 3 秒のポーリングには乗せず（開いたときと「更新」だけ。ボタンは `web/src/RefreshButton.tsx`＝`RefreshMark` ＋文字で、取っている間は CSS でアイコンを回す。#601）、一覧は 60 秒覚える（失敗も覚える）。
- 差分は `gh pr diff` の本文から `diffStats()` で見出しを数え（切る前に数える）、`clampPatch()` で #171 と同じ上限に切り、画面はセッションと同じ `DiffView` で出す。
- `SAI_GH=0` なら `NoPrs`。テストは `PrBrowser` を差し替える（`server/prs.test.ts`）。

### 書いたセッションの入力欄に入れる（#525）

- 書いたセッションは `web/src/prSession.ts` の `prAuthorSession()`（同じ `project` でいまの `branch` が PR の head と同じ一番新しいセッション）。`PrView` が開いたときに絞り込みに依らずそのリポジトリの一覧を 1 回取る。
- 置き場は #511 と同じ `sai.diffComments` で、鍵は `prCommentKey()`＝`pr:<owner/repo>#<番号>`。
- 入れるのは `App` の `insertToSession()`: そのセッションの打ちかけ（`sai.drafts`）の後ろに `appendInsert()` で足してから、そのセッションへ移る。移った先の `ReplyBox` は作られたときに打ちかけを読むが、作られたときにもう来ている `insert` は当てた扱いにするので、#511 の `commentInsert` では入らない。
- 直接は送らない。本文の 1 行目は `formatDiffComments()` の `heading` で PR を名指しする。書いたセッションが返信できなければ口を出さず理由を出す。

### セッションに PR の印を出す（#548 / #554）

- サイドバーは `SessionPrTag`。結び付けは `shared/prs.ts` の `prForSession()`（remote の `owner/repo` とブランチが PR のリポジトリと `head` に一致。fork から出た PR＝`isCrossRepository` → `PrSummary.cross` と、PR の base と同じブランチのセッションは結ばない。同じブランチに 2 本なら新しく動いた方）。
- 材料は同じ `GET /api/prs`。`web/src/useSessionPrs.ts` が開いたとき・見えている間の 60 秒おき・タブに戻ったときだけ取る。色と説明は `web/src/sessionPrState.ts`。
- 印はリンクにしない（項目そのものが `<a>`）。1 行目（リポジトリ / ブランチ）には置かない（長いブランチ名の省略に隠れる）。
- 要対応の行とフィードの見出しは `SessionPrLink`（同じ見た目で、押すと SAI の PR 画面 `prHash()`）。`App` の `sessionPrs` を `TodoView` → `TodoRow` と `FeedView` → `Chat`（`showChannel` のときだけ）に渡すだけで、取得は増やさない。
  - フィードは見出しのブランチ＝その発言を書いたときのブランチで引く（いまのブランチで引くと前の発言に別の PR が付く）。
  - `TodoRow` は名前のリンク（`.who`）の外に並べる（`.who-row`）。

### GitHub にレビューを投稿する

- `POST /api/prs/<owner>/<repo>/<番号>/review`（同一オリジンのみ）。画面は `PrReviewBar` → 確認の画面 `PrReviewModal`。全体のコメントの下書きは `web/src/prReviewDraft.ts` の `sai.prReviewBody`。
- 書いたセッションが見つかる PR では入力欄に入れる方（#525）が既定。種類の既定は Comment。自分の PR（`gh api user` のログイン名＝作者）には Comment しか出さない（サーバも 400）。
- サーバ（`app.ts` の `postPrReview()`）は画面の位置をそのまま渡さない:
  - いまの PR を読み直し、head が画面の読んだ SHA（`commit_id`）と違えば 409 `head_moved`。
  - 行コメントは `shared/prReview.ts` の `githubReview()` がいまの差分でその行を探し直し、中身（`code`）が書いたときと同じときだけ `path` / `line` / `side`（`LEFT` / `RIGHT`）に組み立てる。1 つでも合わなければ 409 `lines_moved` で何も送らない。
- 確認の画面も開いたときに head を見直し、行が変わった・消えたコメント（`reviewLineState()`）は「外す」か「全体のコメントに移す」（`moveToBody()`）まで送らせない。
- 送るのは `gh api -X POST repos/<repo>/pulls/<番号>/reviews --input -` の 1 形だけ（`GhPrs.postReview()`、中身は stdin）。
- `gh` が無い・未ログイン（`viewer()` が null）・`SAI_GH=0` なら `PrDetailResponse.review` を載せず口を出さない。
- 送った・断られたことは `reply.log` に 1 行（本文は書かない）。送れたら下書きを消してレビューへのリンクを出し、失敗したら下書きを残す。
- tailnet 越しも同じ口（追加の関所は無い。Serve の本人確認とタグ付きの端末の 401 は今までどおり）。
