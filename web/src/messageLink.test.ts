import { test } from 'node:test'
import assert from 'node:assert/strict'
import { drawnKey, focusSideIn, isFocused, messageCopyText, messageUrl } from './messageLink.ts'
import { parseRoute } from './hooks.ts'
import { withAttachments } from '../../shared/attachments.ts'

const TS = '2026-09-09T23:14:42+09:00'

test('messageUrl: いま開いている SAI の頭に、セッションと発言の hash を付ける（#503）', () => {
  const url = messageUrl({ origin: 'http://127.0.0.1:8787', pathname: '/' }, 'S1@sai', TS, 'agent')
  assert.equal(url, `http://127.0.0.1:8787/#/s/S1%40sai?ts=${encodeURIComponent(TS)}&side=agent`)
  // hash の部分はそのまま画面の振り分けに通る
  assert.deepEqual(parseRoute(url.slice(url.indexOf('#'))), { name: 'session', id: 'S1@sai', ts: TS, side: 'agent' })
})

test('messageCopyText: 自分の入力は添えた画像のパスを外し、エージェントの発言は記録の文のまま', () => {
  const withImage = withAttachments('これを見て', ['/Users/x/.agent-feed/attachments/0123456789abcdef/fedcba9876543210.png'])
  assert.notEqual(withImage, 'これを見て', '前提: パスが足されている')
  assert.equal(messageCopyText(withImage, 'me'), 'これを見て')
  // エージェントの本文は Markdown の元の文。同じ見出しの形があっても触らない
  assert.equal(messageCopyText('**太字** と `code`', 'agent'), '**太字** と `code`')
  assert.equal(messageCopyText(withImage, 'agent'), withImage)
})

test('isFocused: 名指しした側だけ、side の無い飛び先はどちらでも当たる', () => {
  // 同じ ts の自分の入力と返答
  assert.equal(isFocused(TS, 'me', TS, 'me'), true)
  assert.equal(isFocused(TS, 'agent', TS, 'me'), false, '同じ行の返答は光らせない')
  assert.equal(isFocused(TS, 'agent', TS, 'agent'), true)
  assert.equal(isFocused(TS, 'me', TS), true, 'side の無い飛び先（前の形）は今までどおり両方')
  assert.equal(isFocused(TS, 'agent', TS), true)
  assert.equal(isFocused(TS, 'me', ''), false, '飛び先が無ければ何も光らない')
  assert.equal(isFocused('2026-09-09T23:14:43+09:00', 'me', TS, 'me'), false)
})

test('focusSideIn: 名指しした側のバブルが描かれていなければ、側を問わない（#506 のレビュー）', () => {
  // 検索は Claude の自分の入力にターン完了の行でも当たるが、そちらの自分のバブルは描かれない
  const onlyAgent = new Set([drawnKey(TS, 'agent')])
  assert.equal(focusSideIn(onlyAgent, TS, 'me'), undefined, '無い側を守ると、どこにも着かず追従も止まったままになる')
  assert.equal(focusSideIn(onlyAgent, TS, 'agent'), 'agent')
  const both = new Set([drawnKey(TS, 'me'), drawnKey(TS, 'agent')])
  assert.equal(focusSideIn(both, TS, 'me'), 'me', '両方あれば名指しした方')
  assert.equal(focusSideIn(both, TS), undefined, '名指しが無ければそのまま')
  assert.equal(focusSideIn(new Set(), TS, 'me'), undefined, '行がまだ届いていないときも同じ（どちらでも見つからない）')
})
