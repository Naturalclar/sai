// Manager の案（#565）の札。長い案を畳むかどうかを決める純粋関数（managerDraftFold.test.ts）

/** 畳まずに出す長さ。これを超える案は頭だけ出して「全部見る」で開く */
export const MANAGER_DRAFT_FOLD_CHARS = 240
export const MANAGER_DRAFT_FOLD_LINES = 5

/** 畳むほど長いか（字数か行数のどちらかが超えたら） */
export function managerDraftFolds(text: string): boolean {
  return Array.from(text).length > MANAGER_DRAFT_FOLD_CHARS || text.split('\n').length > MANAGER_DRAFT_FOLD_LINES
}
