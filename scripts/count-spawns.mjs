// 子プロセスを起こす呼び出しを数える preload（#592 の 0。測るときだけ使う。本番の起動には付けない）。
//
//   AGENT_FEED_DIR=<一時ディレクトリ> SPAWN_COUNT_OUT=/tmp/spawn-count.json \
//     node --import ./scripts/count-spawns.mjs server/main.ts --port 8798
//
// spawn / execFile / execFileSync を包み、どの口（HTTP の path。応答の外で起きたものは「(裏)」）からどのコマンドを
// 何回起こしたか、起こす呼び出しそのもの（posix_spawn はイベントループの上で同期に走るので、この間サーバは全部止まる）に
// 何 ms かかったか、子が終わるまでの時間を数え、0.5 秒ごとに SPAWN_COUNT_OUT に JSON で書く。口ごとの応答の時間も書く。
// `kill -USR2 <pid>` で数え直す。サーバのコードは触らない（node:child_process を差し替えて syncBuiltinESMExports() で
// ESM の名前付き import にも効かせる）。
// **本物の ~/.agent-feed で回さない**（AGENT_FEED_DIR を一時ディレクトリにして日付の *.jsonl だけを写す。replying.json・
// 預かり・settings.json は写さない。JEV_API_KEY も渡さない）
import childProcess from 'node:child_process'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { AsyncLocalStorage } from 'node:async_hooks'
import { writeFileSync } from 'node:fs'

const als = new AsyncLocalStorage()
const out = process.env.SPAWN_COUNT_OUT || '/tmp/spawn-count.json'
/** key = 口 \t コマンド → { n, syncMs, lifeMs } */
const stats = new Map()
// 口の名前。id の入るところを畳む（畳まないと id ごとに 1 行になる）。GET 以外はメソッドを頭に付けて分ける
const route = (p, method = 'GET') => {
  const path = p
    .replace(/\?.*$/, '')
    .replace(/^\/api\/sessions\/[^/]+\/(\w+).*$/, '/api/sessions/:id/$1')
    .replace(/^\/api\/sessions\/(?!new$)[^/]+$/, '/api/sessions/:id')
    // sessions の外は 3 つ目から先を畳む（/api/approvals/<id>/answer、/api/prs/<owner>/<repo>/<番号> など）
    .replace(/^(\/api\/(?!sessions(?:\/|$))[^/]+)\/.+$/, '$1/:rest')
  return method === 'GET' ? path : `${method} ${path}`
}
const label = (bin, args) => {
  const name = String(bin).split('/').pop()
  const words = (args || []).filter((a) => typeof a === 'string')
  if (name === 'ps') return `ps ${words.join(' ').replace(/\d+/g, 'N')}`
  if (name === 'tmux') return `tmux ${words[0] ?? ''}`
  if (name === 'lsof') return `lsof ${words.filter((w) => w.startsWith('-')).join(' ')}`
  if (name === 'git') return `git ${words.filter((w) => !w.startsWith('-') && !w.includes('/') && !w.includes('='))[0] ?? ''} ${words.filter((w) => !w.startsWith('-') && !w.includes('/') && !w.includes('='))[1] ?? ''}`.trim()
  if (name === 'gh') return `gh ${words.slice(0, 2).join(' ')}`
  if (name === 'claude') return `claude ${words.slice(0, 1).join(' ')}`
  return `${name} ${words[0] ?? ''}`.trim()
}
const add = (bin, args, syncMs, child) => {
  const store = als.getStore()
  const key = `${store ? route(store.path, store.method) : '(裏)'}\t${label(bin, args)}`
  const s = stats.get(key) ?? { n: 0, syncMs: 0, maxSyncMs: 0, lifeMs: 0 }
  s.n++
  s.syncMs += syncMs
  s.maxSyncMs = Math.max(s.maxSyncMs, syncMs)
  stats.set(key, s)
  const born = performance.now()
  child?.once?.('exit', () => (s.lifeMs += performance.now() - born))
}
for (const name of ['spawn', 'execFile']) {
  const orig = childProcess[name]
  childProcess[name] = function (bin, args, ...rest) {
    const t = performance.now()
    const child = orig.call(this, bin, args, ...rest)
    add(bin, Array.isArray(args) ? args : [], performance.now() - t, child)
    return child
  }
}
const origSync = childProcess.execFileSync
childProcess.execFileSync = function (bin, args, ...rest) {
  const t = performance.now()
  try {
    return origSync.call(this, bin, args, ...rest)
  } finally {
    add(bin, Array.isArray(args) ? args : [], performance.now() - t, null)
  }
}
syncBuiltinESMExports()

// 口ごとの回数と、応答にかかった時間
const requests = new Map()
const origCreate = http.createServer
http.createServer = function (...a) {
  const handler = a.find((x) => typeof x === 'function')
  const wrapped = (req, res) => {
    const t = performance.now()
    const r = route(req.url || '', req.method)
    res.once('finish', () => {
      const s = requests.get(r) ?? { n: 0, ms: [] }
      s.n++
      s.ms.push(Math.round(performance.now() - t))
      requests.set(r, s)
    })
    als.run({ path: req.url || '', method: req.method }, () => handler(req, res))
  }
  return origCreate.call(this, ...a.map((x) => (x === handler ? wrapped : x)))
}
syncBuiltinESMExports()

const dump = () => {
  const rows = [...stats].map(([k, v]) => {
    const [path, cmd] = k.split('\t')
    return { path, cmd, n: v.n, syncMs: Math.round(v.syncMs), maxSyncMs: Math.round(v.maxSyncMs), lifeMs: Math.round(v.lifeMs) }
  })
  // 書けなくても、測っているサーバは落とさない（書き先が無い・権限が無い）
  try {
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), spawns: rows, requests: Object.fromEntries(requests) }, null, 1))
  } catch {
    // 次の 0.5 秒でまた試す
  }
}
setInterval(dump, 500).unref()
process.on('SIGUSR2', () => {
  stats.clear()
  requests.clear()
})
