// サーバが動いているマシンの名前（#114）。画面が「そのセッションは自分のマシンか」を判定する材料で、
// 応答の `host` として載せる。`SAI_HOST` があればそれ、無ければ `os.hostname()`。
import { hostname } from 'node:os'
import { shortHost } from '../shared/host.ts'

/**
 * 自分のホスト名（短い形）。取れなければ空で、そのときは**何もリモートにしない**（shared/host.ts の isRemoteHost）。
 *
 * 短くする規則は `feed/record.py` の `host_name()` と同じ（`shared/host.ts` の `shortHost`）。
 * `AGENT_FEED_HOST` ではなく `SAI_HOST` を見るのは、記録側と読む側で置き場が別になり得るため
 * （集めた JSONL だけを配るマシンでは、記録側の名前と自分の名前が違う）。
 * 毎回 env を読むのは、テストが `SAI_HOST` を差し替えて確かめられるようにするため（呼ばれるのはリクエストごとに1回）
 */
export function selfHost(): string {
  const raw = (process.env.SAI_HOST ?? '').trim()
  if (raw) return shortHost(raw)
  try {
    return shortHost(hostname())
  } catch {
    return ''
  }
}
