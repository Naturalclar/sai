// ペインの中の枠（iframe）を押したことを親の画面で拾う（#897）。判定だけを純粋関数にして node:test で回す。
// 解説のペイン（#887）の枠は `CSP: sandbox` で別オリジン扱いなので、枠の中のクリック・キーは親の document に届かない
// （`ChatPane` の onPointerDownCapture / onFocusCapture が鳴らない）。届くのは、フォーカスが枠に移ったときの親の窓の `blur` と、
// そのときの `document.activeElement`（枠の要素そのもの）だけ。キーは拾えない（`sandbox` は緩めない）

interface NodeLike {
  tagName?: string
}

/** 親の窓の `blur` のあと、フォーカスがこのペインの中の枠に入ったか。アプリを切り替えた（`activeElement` が body）・ほかのペインの枠なら false */
export function frameFocusedIn<N extends NodeLike>(active: N | null, root: { contains(other: N): boolean } | null): boolean {
  return !!active && !!root && active.tagName === 'IFRAME' && root.contains(active)
}
