// #346。実データ（手元の digest.jsonl 667 件）で見つけた型をそのまま置く。
// 本文と一言は、長さだけ詰めて形は変えていない
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { digestIssues, quotedRequests } from './digestCheck.ts'
import { DIGEST_MAX_CHARS } from './persona.ts'

const codes = (source: string, summary: string) => digestIssues(source, summary).map((i) => i.code)

test('quotedRequests: 引用された依頼だけを拾う。引用の無い指示は拾わない', () => {
  assert.deepEqual(quotedRequests('よければ「マージして」と言ってください。'), ['マージして'])
  assert.deepEqual(quotedRequests('着手するときは `#49 に着手して` と言ってもらえれば進めます'), ['#49 に着手して'])
  assert.deepEqual(quotedRequests('復帰後に「続けて」と言ってもらえれば、残りをやります'), ['続けて'])
  assert.deepEqual(quotedRequests('マージしてください。'), [], '引用が無ければ拾わない')
  assert.deepEqual(quotedRequests('「許可が要る」と言って止まります'), ['許可が要る'], '拾うが、問いかけでなければ咎めない')
})

test('引用された依頼が問いかけに化けたら見つける（#346 のきっかけ）', () => {
  // 本文には PR 番号も入っている（実データと同じ形）
  const source = 'PR #284 を出しました。CI は 3 ジョブとも通り、#223 と #320 も同じ形です。main との衝突もありません。マージはまだしていないので、よければ「マージして」と言ってください。'
  assert.deepEqual(codes(source, 'PR #284 作成、モデルボタンを Default に変更。マージして？'), ['quoted_request'])
  assert.deepEqual(codes(source, 'PR 320 作成、CI通りマージ可能！よければマージして？✅'), ['quoted_request'])
  assert.deepEqual(codes(source, 'PR #223 CI完了！merge可能！マージしていい？'), ['quoted_request'], '「〜していい？」も問いかけ')
})

test('引用のまま残っていれば文句を言わない。問いかけでなければ咎めない', () => {
  const source = 'PR #284 を出しました。よければ「マージして」と言ってください。'
  assert.deepEqual(codes(source, 'PR #284 を出したよ。よければ「マージして」と言ってね'), [])
  assert.deepEqual(codes(source, 'PR #284 を出したよ。マージしてと言ってね'), [], '引用符が落ちても、問いかけでなければ意味は変わらない')
  assert.deepEqual(codes('「許可が要る」と言って止まります', 'ツールが拒否されて止まったよ。許可を足す？'), [], '本文の引用と関係ない問いかけは咎めない')
})

test('本文にエージェント自身の問いかけがあれば、一言が問いかけでも構わない', () => {
  const source = 'PR #66 の CI は 3 ジョブとも通りました。マージしますか？'
  assert.deepEqual(codes(source, 'PR #66 通ったよ、マージする？'), [])
})

test('本文に無い番号を書いたら見つける（#268 の裏返し）', () => {
  const source = 'README を書き換えて PR を出しました。CI は pass です。'
  assert.deepEqual(codes(source, 'PR #12 を出したよ、CI も通った'), ['invented_number'])
  assert.deepEqual(codes('PR 64 を出しました（https://github.com/o/r/pull/64）', 'PR #64 出した、CI pass'), [], '本文にある番号はよい')
  assert.deepEqual(codes('issue 168 を作りました', 'PR 〈168〉作成、中身は入力欄の直し'), [], '〈〉付きでも本文にあればよい')
})

test('要約せずプロンプトに答えた、前置き、引用符で囲んだ、は見つける', () => {
  // 本文が短すぎて言い換えられなかった回。本文は何も頼んでいないので invented_request にも当たる
  assert.deepEqual(codes('ALPHA', '変換対象のコーディングエージェントの返答文をいただけますか？'), ['invented_request', 'meta_reply'])
  assert.deepEqual(codes('直したよ', '一言: 直したよ'), ['prefix'])
  assert.deepEqual(codes('直したよ', '「直しておいたよ」'), ['prefix'])
  assert.deepEqual(codes('直したよ', '直しておいたよ'), [])
})

test('長さと空。長さは文字数（絵文字も 1 つと数える）', () => {
  assert.deepEqual(codes('やった', ''), ['empty'])
  assert.deepEqual(codes('やった', '   '), ['empty'])
  assert.deepEqual(codes('やった', 'あ'.repeat(DIGEST_MAX_CHARS)), [])
  assert.deepEqual(codes('やった', 'あ'.repeat(DIGEST_MAX_CHARS + 1)), ['too_long'])
  const long = digestIssues('やった', 'あ'.repeat(DIGEST_MAX_CHARS + 5))
  assert.match(long[0]!.hint, new RegExp(`${DIGEST_MAX_CHARS + 5} 文字`), '実際の長さを理由に入れる（作り直しに渡す）')
})

test('複数あれば、意味が変わるものが先に並ぶ', () => {
  const source = 'よければ「マージして」と言ってください。'
  const got = digestIssues(source, `一言: マージして？ ${'あ'.repeat(DIGEST_MAX_CHARS)}`)
  assert.deepEqual(got.map((i) => i.code), ['quoted_request', 'prefix', 'too_long'])
  assert.ok(got.every((i) => i.hint.length > 0), '理由は全部埋める（作り直しのプロンプトに入る）')
})

// ---- #359: 落ちているものを見つける（意味は変わっていないが、次に何をすればよいか分からなくなる）
test('本文の「人にしてほしいこと」が一言から落ちたら見つける', () => {
  const source = 'PR #66 の CI は 3 ジョブとも通り、マージ可能な状態です。マージするなら言ってください。'
  assert.deepEqual(codes(source, 'PR #66 通ったよ、CI は 3 本とも green！'), ['dropped_request'])
  assert.match(digestIssues(source, 'PR #66 通ったよ')[0]!.hint, /本文の言葉のまま/)
})

test('頼みが残っていれば咎めない（「〜てね」「〜しましょう」「〜して」で終わる形も）', () => {
  const source = 'PR #66 の CI は通りました。マージするなら言ってください。'
  assert.deepEqual(codes(source, 'PR #66 通ったよ。よければ「マージして」と言ってね'), [])
  assert.deepEqual(codes(source, 'PR #66 通った！マージするか教えてください'), [])
  assert.deepEqual(codes('手元で見てください', '画面で見た目を確認して 🚀'), [], '絵文字の前が「〜して」なら頼んでいる')
  assert.deepEqual(codes('checkout を最新にしてください', 'record.py を git pull で更新しましょう'), [])
  assert.deepEqual(codes('次のどちらかをお願いします', 'Bash の承認か別の端末で進めよう！'), [])
  assert.deepEqual(codes('ブラウザで確認してください', '見た目どうかな？'), [], '問いかけも次の一手')
})

test('コードブロックの中の「〜してください」は本文の依頼として数えない', () => {
  const source = ['直し方はこうです。', '```sh', 'echo "これを実行してください"', '```', '以上です。'].join('\n')
  assert.deepEqual(codes(source, '直し方を書いたよ'), [], '貼られたコマンドの中は見ない')
  const outside = ['次を実行してください。', '```sh', 'git pull', '```'].join('\n')
  assert.deepEqual(codes(outside, '直し方を書いたよ'), ['dropped_request'], 'ブロックの外の依頼は数える')
})

test('「待っている」だけで終わったら見つける。終わったらどうなるかがあれば咎めない', () => {
  assert.deepEqual(codes('CI を待っています。通ったらマージします。', 'CI 待ちです ⏳'), ['waiting_without_next'])
  assert.deepEqual(codes('CI を待っています。通ったらマージします。', 'PR #66 を出した！CI 待ちです'), ['invented_number', 'waiting_without_next'])
  // 本文にその先が書かれていなければ言わない（#363。作り直しても直しようがなく、頼みを作る方に押してしまう）
  assert.deepEqual(codes('CI を待っています。', 'CI 待ちです ⏳'), [])
  // 本文に「人がすること」が書かれていない回もある（「通ったら私がマージします」だけ）。
  // そこは本文に無いことを書かせるわけにいかないので、**終わったらどうなるか**があれば通す（#359）
  assert.deepEqual(codes('CI を待っています。通ったらマージします。', 'CI 待ち。通ったらマージしてブランチも消すよ'), [])
  assert.deepEqual(codes('CI を待っています。', 'CI 完了待ちです、終わったら報告します！'), [])
  assert.deepEqual(codes('CI を待っています。通ったら「マージして」と言ってください。', 'CI が通ったら「マージして」と言ってね'), [])
  assert.deepEqual(codes('CI を待っています。マージしますか。', 'CI 待ち。マージしていい？'), [], '問いかけでもよい')
})

test('意味が変わるものが先、落ちているものが次、形の問題は最後', () => {
  const source = 'PR #284 を出しました。よければ「マージして」と言ってください。'
  const got = digestIssues(source, `一言: PR #284 出したよ、マージして？ ${'あ'.repeat(DIGEST_MAX_CHARS)}`)
  assert.deepEqual(got.map((i) => i.code), ['quoted_request', 'prefix', 'too_long'])
  const dropped = digestIssues('CI を待っています。確認してください。', 'CI 待ちです')
  assert.deepEqual(dropped.map((i) => i.code), ['dropped_request', 'waiting_without_next'])
})

// ---- #363: 本文に無いことを足したもの・番号だけ置いたもの
test('本文が報告だけなら、一言も頼み・問いかけを作らない', () => {
  const source = 'PR #53 を作成しました。CI は 3 ジョブとも pass で、マージ可能な状態です。マージはまだしていません。'
  assert.deepEqual(codes(source, 'PR #53 でアーカイブ機能追加、CI 全 pass！マージOK？🚀'), ['invented_request'])
  assert.deepEqual(codes(source, 'PR #53 作成、アーカイブ機能追加。CI 全 pass でマージ可能 🚀'), [], '報告のまま終えればよい')
  assert.deepEqual(codes('Issue を作りました。フックが通知で鳴るところまで入れてあります。', 'Issue 立てたよ、フックが鳴るか確認して 🚀'), ['invented_request'])
})

test('本文が人に何かを求めていれば、一言が求めても作り話ではない', () => {
  assert.deepEqual(codes('マージしますか。', 'CI 通ったよ、マージする？'), [])
  assert.deepEqual(codes('反映するには main worktree を更新する必要があります。', 'マージ完了！/sync-main で反映してね'), [])
  assert.deepEqual(codes('余裕のある日に済ませておくほうが確実です。', 'セール終了は 9/23。余裕のある日に済ませてね！'), [])
  assert.deepEqual(codes('実行するには Plan モードを解除してください。', 'Plan モードなので touch は実行できず。解除して！'), [])
})

test('誘い（「〜しよう」「〜しましょう」）は作り話と数えない（口調の指示にある言い回し）', () => {
  assert.deepEqual(codes('README を書き換えました。', 'README 直したよ、次いこう！'), [])
})

test('NFD の本文でも判定する（実データに混じっている）', () => {
  // 「ください」が く + 濁点 + さ + い で書かれた本文（macOS 由来）
  const nfd = '実行するには Plan モードを解除してください。'.normalize('NFD')
  assert.deepEqual(codes(nfd, 'Plan モードなので touch は実行できず。解除して！'), [], 'NFC に揃えてから見る')
})

test('番号だけが置かれていて、本文に題名があれば見つける', () => {
  const source = ['issue を 3 つ立てました。', '- **#76 サイドバーの矢印移動を入れる**: url', '- **#78 仕様書を実装に合わせて更新する**: url'].join('\n')
  assert.deepEqual(codes(source, '#76 / #78 を立てました！'), ['bare_number'])
  assert.match(digestIssues(source, '#76 / #78 を立てました！')[0]!.hint, /サイドバーの矢印移動/, '本文の言葉を理由に入れる')
  assert.deepEqual(codes(source, '#76 サイドバーの矢印移動など 2 件を立てたよ'), [], '主なもの 1 つに説明が付いていればよい')
})

test('本文に題名が無ければ、番号だけでよい', () => {
  assert.deepEqual(codes('PR #79 を squash でマージしました。衝突なしで一発です。', 'PR #79 マージ完了！'), [], '地の文は題名と数えない')
  assert.deepEqual(codes('issue #232 はこれで完了です。', '#232 完了！'), [])
})

// ---- #376: 人が頼んだことは、番号の裏付けにだけ使う
test('頼んだことにある番号は作り話と数えない（#376）', () => {
  const source = '着手しました。ブランチを切って 🚧 のコメントを付けています。'
  assert.deepEqual(codes(source, '#371 に着手したよ、ブランチも切った'), ['invented_number'], '渡さなければ今までどおり')
  assert.deepEqual(digestIssues(source, '#371 に着手したよ、ブランチも切った', '#371 に着手して').map((i) => i.code), [])
  assert.deepEqual(digestIssues(source, '#999 に着手したよ', '#371 に着手して').map((i) => i.code), ['invented_number'], '頼んだことにも無い番号は今までどおり')
})

test('頼んだことは依頼・題名の判定には混ぜない（#376）', () => {
  // 頼みごとは必ず「〜して」の形なので、混ぜると invented_request がほぼ鳴らなくなる
  const source = 'PR を作成しました。CI は 3 ジョブとも pass です。'
  assert.deepEqual(digestIssues(source, 'PR 作成、CI 全 pass！マージしていい？', 'PR を出しておいてください').map((i) => i.code), ['invented_request'])
  // 本文に題名が無ければ、頼んだことに題名があっても番号だけでよい
  assert.deepEqual(digestIssues('立てました。', '#76 作成！', '#76 サイドバーの矢印移動を入れる、を立てて').map((i) => i.code), [])
})
