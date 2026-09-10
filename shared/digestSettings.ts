// 一言コメント（digest）の入切・口・モデルの検査（#288）。前は環境変数（SAI_DIGEST / SAI_DIGEST_PROVIDER / SAI_DIGEST_MODEL）で、
// サーバを立て直すたびに打ち直していた。いまは settings.json に持ち、画面（自分のメニュー）から変える。
// サーバの PUT /api/settings の受付と settings.json の読み込みが同じ関数を使う。
// **本文の送り先（SAI_DIGEST_URL）と鍵（SAI_DIGEST_API_KEY）はここに入れない**（画面から外へ向けられないよう環境変数のまま）
import { META_MODEL_MAX, META_MODEL_RE } from './meta.ts'
import type { DigestProvider } from './types.ts'

/** 選べる口。`claude`（`claude -p`。既定）か `openai`（OpenAI 互換の `/v1/chat/completions`。ローカルの LLM はこちら） */
export const DIGEST_PROVIDERS: readonly DigestProvider[] = ['claude', 'openai']

export function isDigestProvider(value: unknown): value is DigestProvider {
  return value === 'claude' || value === 'openai'
}

/**
 * 一言を作るモデル名として受けてよいか。**空は「口の既定」**（claude は haiku、openai は既定が無いので作らない）。
 * 形は返信のモデルと同じ検査（`shared/meta.ts` の `META_MODEL_RE`）。先頭の `-` を受けないのは、
 * `claude -p --model <m>` の引数に化けるため
 */
export function isDigestModel(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || (value.length <= META_MODEL_MAX && META_MODEL_RE.test(value)))
}
