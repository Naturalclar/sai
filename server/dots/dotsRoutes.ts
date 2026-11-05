// dots との会話ログの口（#872）。`GET /api/dots` で会話を読み、`POST /api/dots` で人の投稿を受信箱に足す。
//
// - POST は**同一オリジンのみ**（`isCrossOrigin()`）。読む GET はほかの画面と同じ認証（`createApp()` の手前で済んでいる）
// - セッション・cwd・ファイルには触らない。**外には何も出さない**（配信は受信箱のアダプター #873）
// - `createDotsRoutes(ctx)` は関数を作って返すだけ（`app.ts` を import しない。#807 の形）
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DOTS_TEXT_MAX } from '../../shared/dots.ts'
import type { DotsPostRequest, DotsPostResponse, DotsResponse } from '../../shared/dots.ts'
import type { AppContext } from '../appContext.ts'
import type { DotsInbox } from './inbox.ts'

export const DOTS_PATH = '/api/dots'

/** body の上限。本文の上限（字）を UTF-8 にしても収まる大きさ */
const MAX_DOTS_BYTES = DOTS_TEXT_MAX * 4 + 1024

/** 会話の id の形（サーバが作る UUID）。それ以外は受けない */
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function createDotsRoutes(ctx: Pick<AppContext, 'json' | 'error' | 'readJson' | 'isCrossOrigin'> & { dotsInbox: DotsInbox }) {
  const { json, error, readJson, isCrossOrigin, dotsInbox } = ctx

  const getDots = async (res: ServerResponse) => {
    const rev = await dotsInbox.rev()
    const payload: DotsResponse = { rev, conversations: await dotsInbox.conversations() }
    return json(res, payload)
  }

  const postDots = async (req: IncomingMessage, res: ServerResponse) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let body: unknown
    try {
      body = await readJson(req, MAX_DOTS_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return error(res, 400, 'body はオブジェクトで送ってください')
    const b = body as Partial<DotsPostRequest>
    const text = typeof b.text === 'string' ? b.text.trim() : ''
    if (!text) return error(res, 400, 'text（本文）を送ってください')
    if ([...text].length > DOTS_TEXT_MAX) return error(res, 400, `text は ${DOTS_TEXT_MAX} 文字までです`)
    let conversationId: string | undefined
    if (b.conversation_id !== undefined) {
      if (typeof b.conversation_id !== 'string' || !CONVERSATION_ID.test(b.conversation_id)) return error(res, 400, 'conversation_id の形が違います')
      if (!(await dotsInbox.hasConversation(b.conversation_id))) return error(res, 404, 'その会話が見つかりません')
      conversationId = b.conversation_id
    }
    const message = await dotsInbox.post(text, conversationId)
    const payload: DotsPostResponse = { ok: true, message }
    return json(res, payload)
  }

  return { getDots, postDots }
}
