import { useState } from 'react'
import { IconButton } from './IconButton'
import { DiffMark } from './DiffMark'
import { DiffModal } from './DiffModal'

/** チャット見出しの「差分」。押したときにだけ git を読みに行く（ポーリングには乗せない） */
export function DiffButton({ id }: { id: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton label="このセッションの差分を見る" onClick={() => setOpen(true)}>
        <DiffMark />
      </IconButton>
      {open && <DiffModal id={id} onClose={() => setOpen(false)} />}
    </>
  )
}
