/**
 * チャット見出しの「使ったモデル」。記録（`SessionSummary.model` / `models`）から出すだけで、操作は無い。
 * 返信で使うモデルを**変える**のは入力欄の `ReplyModelPicker`（送信ボタンの左）に 1 か所だけ置く（#193）
 */
export function ModelTag({ model, models }: { model: string; models: string[] }) {
  if (!model) return null
  return (
    <code className="model-tag" title={models.length > 1 ? `使ったモデル（順に）: ${models.join(' → ')}` : '一番新しいターンを回したモデル'}>
      {model}
      {models.length > 1 && <span className="more">+{models.length - 1}</span>}
    </code>
  )
}
