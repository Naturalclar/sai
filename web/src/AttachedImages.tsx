/** バブルに出す添付のサムネイル。押すと元の大きさで開く（新しいタブ） */
export function AttachedImages({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null
  return (
    <div className="attached">
      {urls.map((url) => (
        <a key={url} href={url} target="_blank" rel="noopener noreferrer" title="元の大きさで開く">
          <img src={url} alt="添付した画像" loading="lazy" />
        </a>
      ))}
    </div>
  )
}
