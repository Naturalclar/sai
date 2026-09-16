// 返信のモデル候補を OpenCode の本体から取る（#394）。応答を `provider/model` の一覧にするだけの純粋関数で、
// 取りに行くのは `server/reply/opencodeServer.ts`、並べるのは `web/src/modelChoices.ts`。
//
// 実機（1.18.30）で確かめたこと:
// - **`GET /config/providers?directory=<cwd>` を使う**。`directory` は効いていて、**その worktree の
//   `opencode.json` で足した provider まで出る**（サーバを別の場所で起こしても、そこにしか無い provider が
//   `directory` を変えると現れ／消えることで確認した）。SAI のサーバは homedir で動くので、渡さないと取りこぼす
// - `GET /api/model` は 93 件返すが **`location` を渡さないとサーバの場所のぶんだけ**で、プロジェクト限定の
//   provider が出ない。**数の多さ（93）より、その人が実際に使えるもの（設定済みの provider）**の方が候補として役に立つ

/** `GET /config/providers` の応答から、候補になる `provider/model` を出てきた順に返す */
export function opencodeModels(data: unknown): string[] {
  const providers = (data as { providers?: unknown })?.providers
  if (!Array.isArray(providers)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of providers) {
    const provider = raw as { id?: unknown; models?: unknown }
    const id = typeof provider.id === 'string' ? provider.id.trim() : ''
    if (!id || typeof provider.models !== 'object' || provider.models === null) continue
    for (const name of Object.keys(provider.models as Record<string, unknown>)) {
      const model = name.trim()
      // 保存する値はメタと同じ `provider/model`（`promptBody()` が最初の `/` で割る。#382）
      const full = `${id}/${model}`
      if (!model || seen.has(full)) continue
      seen.add(full)
      out.push(full)
    }
  }
  return out
}
