// サーバが動いているマシンの名前（#114）。画面が「そのセッションは自分のマシンか」を判定する材料で、
// 応答の `host` として載せる。`AGENT_FEED_HOST` があればそれ、無ければ `os.hostname()`（record.py の `host_name()` と同じ順）。
import { hostname } from 'node:os'
import { shortHost } from '../shared/host.ts'

/**
 * 自分のホスト名（短い形）。取れなければ空で、そのときは**何もリモートにしない**（shared/host.ts の isRemoteHost）。
 *
 * **記録側（`record.py`）と同じ `AGENT_FEED_HOST` を見る**（#288）。サーバが比べたいのは「このマシンの `record.py` が
 * 行に書く名前」なので、同じ変数・同じ規則（`shortHost` = `host_name()`）で決めれば、同じ環境から起動している限り揃う。
 * 前は別の `SAI_HOST` を見ていて、README の手順どおり `AGENT_FEED_HOST` だけ設定すると自分のセッションが
 * 「別のマシン」になり、返信の口まで消えた。記録しない（集めた JSONL を配るだけの）マシンでは自分のセッションが
 * 無いので、名前が何でも判定には効かない。
 * 毎回 env を読むのは、テストが差し替えて確かめられるようにするため（呼ばれるのはリクエストごとに1回）
 */
export function selfHost(env: NodeJS.ProcessEnv = process.env, machine: () => string = hostname): string {
  const raw = (env.AGENT_FEED_HOST ?? '').trim()
  if (raw) return shortHost(raw)
  try {
    return shortHost(machine())
  } catch {
    return ''
  }
}
