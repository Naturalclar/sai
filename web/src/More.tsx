/** 「+N」。リポジトリやブランチが途中で変わったセッションで、最後の値の横に残りの数を出す */
export const More = ({ n }: { n: number }) => (n > 1 ? <span className="more">+{n - 1}</span> : null)
