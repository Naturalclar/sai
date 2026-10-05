# 一言（digest）の仕組み

CLAUDE.md から移した「どう動くか」。守る決まりは CLAUDE.md、経緯は [history/digest.md](../history/digest.md)。

利用者から見た振る舞い（何を作るか・既定はオフ・性格・「作らない」・リンク・変？・次に送る文面の案）は [screen.md](../screen.md) の「一言コメントと性格（digest）」、設定と API の形は [api.md](../api.md) の `/api/settings` と `/api/digest/feedback`、ローカルの LLM は [local-llm.md](../local-llm.md) の「一言コメント（digest）」。ここはコードのどこで何をしているかだけを書く。

## 口と設定

- 本体は `server/digest/digest.ts`。入にしているとき（`settings.json` の `digest`。自分のメニューの `DigestEngineControls`）、入にしたあとに増えたターン完了の行を言い換えて `~/.agent-feed/digest.jsonl` に追記する（JSONL は触らない）。
- 口は `digest_provider` で選ぶ: `claude`（既定。`ClaudeSummarizer`）か `openai`（`OpenAISummarizer`。`SAI_DIGEST_URL` の `/chat/completions` を `fetch`。`digest_model` 必須、鍵は `SAI_DIGEST_API_KEY`）。どちらも `Summarizer`（`summarize(prompt)`）の実装で、`summarizerFactory()` が口とモデルから組む。
- `openai` の要求には `REASONING_OFF`（`reasoning_effort: 'none'`）を付ける。付けたまま 400 / 422 なら（`mayRetryWithoutReasoning()`）外して 1 回だけ送り直し、**通ったときだけ**その口には付けずに送る（サーバの stderr に 1 行）。この覚えは `OpenAISummarizer` のインスタンス限りで、`configure()` が口を作り直したらもう一度確かめる。送り直しを含めて 1 件の上限は `DIGEST_TIMEOUT_MS`（`AbortSignal` は 1 つ）。それでも返る `<think>…</think>` は `stripThinking()` で落とす。
- 入切・口・モデルは立て直さずに切り替わる（#288）: `createApp` が起動時に `settings.json` を `Digester.configure()` に渡し、`PUT /api/settings` がそのキーを変えたらもう一度渡す。
- 切から入にしたら境目（`sinceMs`）を「いま」に進める。切ったら列を捨てる（作りかけの 1 件だけは終わらせる）。openai でモデルが空なら作らずに `SettingsResponse.digest_error` に理由を出す（`digest` = いま作っているか、`digest_on` = 入にしているか）。
- モデル名の検査は `shared/digestSettings.ts` の `isDigestModel()`（返信のモデルと同じ形）で、PUT の受付と `settings.json` の読み込みが同じものを使う。
- 応答時に `FeedRow.summary` / `SessionSummary.last_summary` として載せ、rev にも混ぜる。
- 画面は `Message.tsx` が一言 + 「詳細」で元の本文を開く。

## 失敗と間隔

- 口が落ちていても同じ行を叩き続けない（#443）: 失敗した行は `failed` に回数と次の時刻を持ち、`scan()` は間隔（`DIGEST_RETRY_DELAYS_MS` = 1 → 5 → 30 分）が来るまで積まず、`DIGEST_MAX_TRIES`（4）回で諦めて `digest.log` に「諦めた」と残す。
- 続けて `DIGEST_ALERT_FAILS`（3）回失敗したら `digest_error` に口の不調を出し（`Summarizer.where` で送り先を添える）、1 回でも通ったら消す。口やモデルを変えたら（`configure()`）数え直す。
- 同時に、列を進めずに `DIGEST_BREAK_MS`（5 分）口を休ませる（#497。遮断器）。休んでいる間に届いた行は列に積むだけで捨てず、`digest_error` に「n 分後に再開」と出す。休み明けは 1 件だけ試し、通れば平常に戻って続きを回し、落ちればまた休む。口を変えたら（`configure()`）休みも解く。
- `digest` が true のままでも `digest_error` は出るので、`DigestEngineControls` は `digest_error` があれば「作成中」の代わりにそちらを出す。設定は起動時に 1 回しか取らないので、自分のメニューを開いたときに取り直す（`useSettings` の `refresh()`）。

## 性格とセッションごとの切り替え

- プロンプトと MBTI の口調表は `shared/persona.ts`（`digestPrompt()`）。
- 性格は行ごとに `personaResolver()` が決める: セッションのメタ（`session-meta.json` の `persona`。チャット見出しの `SessionPersonaSelect`）にあればそれ、無ければ全体の既定（`server/meta/settings.ts` の `SettingsStore`、`~/.agent-feed/settings.json`、`GET/PUT /api/settings`。ヘッダの `PersonaSelect`）。
- セッションごとに切れる（#263）: 同じ resolver が `digest_off` のセッションで `null` を返し、`pump()` がそれを見て一言を作らない。メタの読み出しは非同期なので同期の `scan()` では引けず、「作るか」と「どの口調か」を 1 回の読み出しで決める。
- 切る前に作ってあるぶんは表示側で落とす（`withLastSummary` と `/api/feed` の `digestOffIds()`）。
- 一言を作る `claude -p` の子プロセスには `AGENT_FEED_SKIP=1` を渡す。

## 番号のリンク

- 一言の中の `#123` / `owner/repo#123` / Linear の `PGR-123` / URL は `shared/refs.ts` の `linkifyRefs()` が Markdown の `Inline` の木にしてリンクにする（`#123` の向き先は行の `remote`、Linear の workspace は `settings.json` の `linear_workspace`）。
- `linkifyRefs()` に `ctx.source`（言い換える前の本文）を渡すと、そこに無い番号はリンクにしない（消さずに文字のまま残す。`Message.tsx` が `summary` と一緒に持っている `text` を渡す）。裏付けは同じ regex で拾うので本文の `#1234` が一言の `#123` に当たらず、本文が URL（`<remote>/issues/70`）で番号を出していれば裏付けになる。`owner/repo#123` と URL はそのまま通す（行き先が本文に依らない）。`source` を渡さなければ全部リンクにする。
- `source` には行の `user_text` も足す（`Message` の `sourceAsk`。頼んだことから来た正しい番号をリンクにするため）。
- テストは `shared/refs.test.ts`。

## 出来上がりの確かめ（digestIssues の各項目）

- `shared/digestCheck.ts` の `digestIssues(source, summary, ask)` が出来上がりを見る（LLM を呼ばない純粋関数）。引っかかったら理由を添えて `digestPrompt(persona, text, { summary, issues })` でもう一度だけ頼み、問題が減ったときだけ採る。残った点は `DigestEntry.issues` と `digest.log` に書き、作り直したことは `retried` に載せる（#346）。
- 判定の前に本文と一言を NFC に揃える。
- 見るもの:
  - 引用された依頼が問いかけに化けた（本文の `「マージして」と言ってください` → 一言の `マージして？`）・要約せずプロンプトに答えた・前置きや引用符・長さ超過（#346）。
  - `invented_number`: 本文に無い番号。`ask`（行の `user_text`）は番号の裏付けとしてだけ使い、依頼・題名の判定には混ぜない（#376）。
  - `dropped_request`（#359）: 本文に人への依頼（`〜てください` / `お願いします`。` ``` ` の中は見ない）があるのに一言が触れていない。依頼が残っているかは口語の形も見る（`〜てね` / `〜しましょう` / `〜して 🚀` のように末尾が依頼・誘いなら残っている扱い。`endsWithRequest()`）。
  - `waiting_without_next`（#359 / #363）: 一言が「待っている」で終わっていて、人がすることも終わったらどうなるかも無い。`通ったら…` があれば咎めない。本文にその先（`SOURCE_NEXT` か `通ったら…`）が書かれているときだけ言う。
  - `invented_request`（#363）: 一言が人に何かを求めているのに、本文には頼みも質問も無い。本文の側は `SOURCE_NEXT` で広く見る（`〜してください` のほか `〜する必要があります` / `〜したほうが` / `マージしますか。` も「人がすること」）。一言の側は `asksPerson()` で狭く見る（誘い `〜しよう` / `〜しましょう` は数えない）。
  - `bare_number`（#363）: 一言の番号のあとが動作の語だけ（`#76 作成`、`PR #73 マージ完了`）で、かつ本文にその番号の題名があるときだけ言う（`numberTitle()`。`#79 を squash マージしました` のように助詞で続く地の文は題名と数えない）。一言の中のどれか 1 つに説明が付いていれば、残りは番号だけでよい。
  - `action_swap`（#378）: 番号に添えた動作の取り違え（本文 `PR #377 をマージしました` → 一言 `PR #377 作成`）。一言は番号の直後だけ見る（`ブランチ作成。PR #356 マージ後確認` の `作成` はその番号のことではない）。本文は済んだ形だけ見る（`マージします` / `マージ可能` / `マージはしていない` では言わない）。本文にもう片方の動作も書いてあれば言わない。逆向き（本文は作っただけなのに一言が「マージ済み」）も同じ条件で見る。
  - `kind_swap`（#540）: 番号の種類（PR / Issue）の取り違え（本文 `Issue #536 を作りました` → 一言 `PR #536 作成`）。一言は番号の直前の語だけ見て、本文（と頼んだこと）が語（`Issue #N` / `PR #N`）か URL（`/issues/N` / `/pull/N`）で反対の種類だけで呼んでいるときに言う。両方で呼んでいる・どちらとも呼んでいない（裸の `#N`）ときは言わない。
- プロンプトの骨格（#359）は「①何をしようとしたか ②そのままできなかったならなぜか ③いまどうなっているか（待っているなら何を待っているか）④人が次にすること」で、本文に書いてあるものだけを使わせる。「番号に添える動作は本文の言葉のまま」（#378）、「種類は本文にあるときだけ」（#540）もプロンプトに書いてある。作例は型だけ（`例:「PR 〈番号〉作成、〈その PR が何をするか〉」` から種類と動作の語も抜いたもの）。

## 人に聞いている返答は一言にしない（#638）

- 判定は `shared/fullText.ts` の `needsFullText(text)`（LLM を呼ばない純粋関数。`fullText.test.ts`）。当たるのは 2 つだけ:
  - 「決めてほしい」「決めること」「確認したいこと」などの語が、**見出し・太字・「:」で終わる短い行**にある
  - **最後の段落**（空行で区切った最後のかたまり）に、`？` か「〜ますか」「〜でしょうか」などで終わる文がある
- コードブロック・インラインコード・引用（`>`）・表の行・URL は見ない（落とした行は空行にせず印を置くので、表やコードで終わる返答の「最後の段落」は表の前の段落にならない）。半角の `?` は後ろが空白か行末のときだけ文の終わり。「決めることは残っていません」のように打ち消している見出しは当てない。途中の段落の問いかけも見ない。**狭い方に倒す**（外れた返答は今までどおり一言になるだけ）。
- `Digester.pump()` が、一言を作る行（全体で入・セッションで切っていない）のときだけ判定する。当たれば一言の口を叩かず、`digest.jsonl` に `summary: ''` と `skipped: 'asking'` を残す。`scan()` は `skipped` のある行を積み直さない（案だけ作った行（#560）は一言が空でも積み直すので、印で分ける）。
- 案（`next_ask`）は別のプロンプトなので今までどおり作る。案に失敗しても印は残し、口の失敗には数えない（`makeNextAsk()` が飲み込む）。案だけ作ってあった行をあとから判定したときは、案を持ち越す。
- `feed/digest_stats.py` は `skipped: asking` の行を一言の数に入れず、「一言にしなかった: N 本」と別に出す。

### 規則で拾えない分は、一言を作っている手元のモデルに聞く（#639）

- 規則が当てなかった行だけ、一言を作る前に**同じ口（`Summarizer`）へ別の呼び出しで** 1 回聞く（`Digester.judgeFullText()`）。プロンプトと答えの読み方は `shared/fullTextJudge.ts`（`fullTextJudgePrompt()` / `parseFullTextJudge()`。`fullTextJudge.test.ts`）。
- **聞くのは口が `openai`（手元）のときだけ**。`claude` の口では聞かない（呼び出しが 1 回増えるぶん時間とトークンが掛かる）。セッションで一言を切っている行・失敗して作り直している行でも聞かない。
- プロンプトは本文を先、問いを後に置き、「終わった作業の報告か、人の判断を待っている途中の話（案の比較・提案・相談・未解決の問題の説明）か」を `SUMMARY` / `FULL` の 1 語で答えさせる。本文が長ければ頭と末尾だけ渡す（`judgeBody()`）。作例・具体的な番号・中身の語は置かない。
- `FULL` なら一言の口を叩かず、`digest.jsonl` に `summary: ''`・`skipped: 'judged'`・`judge: 'full'` を残す（画面の出し方と積み直さないことは #638 と同じ）。`SUMMARY` なら今までどおり一言を作り、`judge: 'summary'` を残す（あとで合図と突き合わせるため）。
- **答えが 1 語でない・空・呼び出しが失敗したときは、今までどおり一言を作る**（`judge` は付けない。`digest.log` に「判定が読めない」「判定に失敗」）。判定の失敗は口の失敗に数えない（口が落ちていれば、続く一言の呼び出しが数える）。**時間切れだけは別**で、続けて一言を叩かずにその行の失敗として数える（`isTimeout()`。口が固まっているときに 1 行で 2 回待たない）。
- `feed/digest_stats.py` は「手元のモデルの判定」の行に、全文が要ると答えた本数と、足りると答えたうち詳細を開いた本数（拾えなかった分）を出す。全文が要ると答えた行は本文がそのまま出ていて「開く」が無いので、誤って拾ったかは合図からは分からない。

## 変？のフィードバック

- `POST /api/digest/feedback` が `~/.agent-feed/digest-feedback.jsonl` に追記する（`server/digest/feedback.ts`）。理由の一覧と鍵の作り方は `shared/digestFeedback.ts`（`digestKey()` はサーバと画面が同じ関数を使う）。一言・口・性格は鍵から引く。
- 画面は一言の横の「変？」（`web/src/DigestFeedback.tsx`）。
- 理由には `why`（なぜそうしたか分からない）と `next`（次にすることが分からない）がある（#359）。

### 使われたかを数える（#446）

- 同じ口・同じファイルに、画面の操作のついでの合図を 2 つ溜める（`shared/digestFeedback.ts` の `DIGEST_USAGE_REASONS`）: `opened`（`Message` の一言の「詳細」を開いた。閉じるときは送らない）と `next_ask_accepted`（`ReplyBox` で一言の口の案を `→` / チップで受け取った。鍵は `<エンティティID>|<last_turn_ts>`。Manager の案と履歴の続きは数えない）。
- 画面は `web/src/digestUsage.ts` の `reportDigestUsage()`。同じ鍵・同じ合図はページを開いている間 1 回だけ（`digestUsageOnce.ts` の `firstUse()`）。失敗しても何も出さない。
- `FeedbackStore.size` と応答の `count` は「変？」だけを数える（合図で「ありがとう、N 件目」を増やさない）。
- 集計は `python3 -m feed.digest_stats`（`feed/digest_stats.py`。標準ライブラリのみ・読むだけ）。一言のうち詳細を開いた割合、案の受け取り率を、全体・モデルごと・性格ごとに出す。分母は既定で、最初の合図より後に作ったものと、それより前で合図が付いたもの（`--all` で全部）。画面には出さない。表示しただけ（impression）は数えない。

## 頼んだことを渡す

- 一言には「人が頼んだこと」も渡す（#376）: `digestPrompt(persona, text, { ask })` に行の `user_text` を入れる（`DIGEST_ASK_MAX_CHARS` = 200 字で切る）。
- 渡すのは「何の話の回か」を掴ませるためだけなので、プロンプトにも「一言にするのは返答の方」と書く。
- `digestIssues()` には番号の裏付けとしてだけ渡す（`digestIssues(source, summary, ask)`。`#371 に着手して` と頼まれた回の `#371` は作り話ではない）。
- #372 の `nextAskPrompt(row.user_text, row.text)` は元から人の入力を渡している。

## 次に送る文面の案

- 同じ pump・同じ口で「次に送る文面の案」も作る（#371）。プロンプトと後始末は `shared/nextAsk.ts` の `nextAskPrompt()` / `cleanNextAsk()`。
- 一言とは別に入切する（#560）: `settings.json` の `next_ask`（無ければ `digest` に従う）。読むときに埋めない（判定は `nextAskOn()`）。
- `Digester` は `enabled`（一言）/ `nextAskEnabled`（案）/ `active`（どちらか＝口を組んで列を回す）を分けて持つ。
- 一言を切っている（全体の `digest: false` かセッションの `digest_off`）行でも、一番新しい行なら案だけ作り、`digest.jsonl` に一言の空の行（`summary: ''`）として書く（書かないと 3 秒ごとの `scan()` が同じ行を積み直して口を叩き続ける）。読む側（`summaryFor()` / `attach()` / 一言への「変？」）は空を「一言なし」として扱い、セッションの `digest_off` を戻したら空の行にも一言を作る（案は叩き直さない）。
- 一言を切っていて案だけのときの失敗も、一言と同じく数えて間を置く（#443 / #497）。一言を入にした瞬間は、案だけ作っていた間の行までさかのぼらない。
- `withLastSummary()` は `digest_off` でも案は載せ、案を切っているときは載せない。
- 一言を作った直後にもう 1 回呼ぶ（1 回の返答に両方書かせて割る形にはしない）ので、案が失敗しても一言は残る（理由は `digest.log`）。
- 作るのはそのセッションの一番新しい行のときだけ（`isLatest()`。口を叩く回数はセッションごとに 1 ターン 1 回に収まる）。作っている間に画面から切られたら叩かない。
- 材料は `row.text` と `row.user_text`。性格（口調）は足さない。
- 結果は `digest.jsonl` の同じ行の `next_ask` に入り、`SessionSummary.next_ask` として載る（`withLastSummary()`）。
- 画面は打ちかけの続き（#219）と同じゴースト（`.field > .ghost`。placeholder と同じ位置・同じ色）に出し、`→` で受け取る（#373。入るだけで送らない）。出しどころを決めるのは `web/src/replySuggest.ts` の `suggestionFor()` 1 つで、打ちかけがあれば履歴の続き、空なら案（履歴の続きは本文が空では出ないので重ならない）。
- ゴーストを出している間は placeholder を空にし（同じ場所に重なる）、消える分の読み上げは `aria-label` に回す。処理中は案を出さない。タッチ端末では `SuggestionChip` も出す（文言だけ案のものに差し替える。#349）。
- フィードには渡さない。チップも入力欄も Markdown を通さないので、案の中の `#123` がリンクになることは無い。

## プロンプトの案を比べる（`pnpm digest:eval`。#712）

プロンプトを変える前に、**同じ事例・同じ回数**で今の案と比べる道具。置き場は `server/tools/digest-eval/`。口を叩くので**手元で回す**（CI に載るのは、事例の形の検査と採点・集計のテストだけ）。

```
pnpm -s digest:eval                                  # 今のプロンプトを、作り物の事例で 1 回ずつ
pnpm -s digest:eval --variants current,bare --runs 3 # 2 つの案を比べる（最初が今の案）
pnpm -s digest:eval --feed --days 7 -n 50            # ~/.agent-feed の実際の返答を事例にする（読むだけ）
```

- **事例**（`cases.json`）は**作り物だけ**。実際の返答の形（`score.ts` の `SHAPES`: 完了の報告・「マージして」待ち・質問で終わる・失敗・番号が複数・番号なし・英語・長い）を写し、中身は書き直す。番号は `CASE_NUMBER_MIN`（9000）以上だけ。
- **守ること**（事例の `expect`）は一言の文字だけで見られる形: `keep`（そのまま残る文字）/ `numbers`・`no_numbers`（出る・出ない番号）/ `action`（動作の語。どれか 1 つ）・`no_action`（出てはいけない動作の語）/ `request`（`keep` = 人が次にすることが残る・`none` = 頼みを作らない）。頼みの有無は `digestCheck.ts` の `hasNextAction()` / `asksPerson()` をそのまま呼ぶ。
- **採点**は `scoreSummary()`: `digestIssues()` の項目と、守ることに反した項目（`expect:` 付き）を続けて返す。LLM の採点役は使わない。
- **歯止め**は `validateCases()`（`score.test.ts` が `cases.json` に当てる。CI で回る）: 形の誤り・守ることと本文の食い違い（本文に無い番号を「出る」と書く、など）・`caseLeaks()` が見つけた形（ホームのパス・メールの形・UUID と `ses_` の ID・`github.com/<アカウント>`・`dev-` で始まる worktree 名・9000 未満の番号）。呼び名は一覧にできないので見ていない（PR のレビューで見る）。
- **案**は `variants.ts` の `VARIANTS`。案は「本文と頼んだことを受けて一言を返す関数」で、口を呼ぶ回数は案が決める（2 つの欄を繋ぐ・LLM を呼ばずに抜き出す、も書ける）。`current` は `digestPrompt()` の 1 回目の一言（作り直しは含めない）、`bare` は規則なしの物差し。
- **回し方**（`cli.ts` の `runEval()`）: 事例 × 回 × 案を順に。同じ事例・同じ回を案で続けて回す。人に聞いている返答（`needsFullText()`。本番では一言にしない）は回さない（`--include-asking` で回す）。口が落ちた回は `error` として残す。
- **集計**（`report.ts`）: 項目ごとの件数（案ごと）、長さ（最小・中央・90%・最大・80 字超）、今の案との差、事例ごとにどちらが良かったか。比べるのは**両方の案で一言が取れた組だけ**。悪くなった項目は頭に `▲` を付けて先に並べる。
- **通す条件**（`GATES`）: 「本文に無い番号」「頼みが落ちた」「動作の取り違え」の 3 つは、今の案より 1 件でも増えていたら通さない（終了コード 1）。`digestIssues()` の項目と、同じことを事例の側から見た項目を 1 つの組に数える。
- **口**は `settings.json` の口・モデル・性格（`--provider` / `--model` / `--persona` で変えられる）で、作るのはサーバと同じ `summarizerFactory()`（送り先は `SAI_DIGEST_URL`）。口が `claude` のときは `--claude` を付けたときだけ回す。
- **出すもの**: 標準出力は件数と割合だけ（PR に貼れる）。本文と一言は `--out`（既定は一時ディレクトリ。**リポジトリの中は断る**）の `outputs.jsonl` にだけ残る。`--feed` は読み方を `feedRead.ts` から借り、事例の ID は連番にする（セッションの ID を出力に持ち込まない）。

## テスト

- `Summarizer` を差し替えた `Digester` を `createApp` の第 6 引数に渡す。
- テストで差し替えた `Digester` は起動時に組み直さない（渡した入切のまま）。
- 偽の `Summarizer` は一言と案のプロンプトを別に数える（同じ口を 2 回叩くので、混ぜると一言の回数を見ているテストが狂う）。
- `persona.test.ts` がプロンプトの `#<数字>` の直書きと作例の語（種類・動作の語を含む）を止める。`shared/refs.test.ts` が番号のリンクを見る。
