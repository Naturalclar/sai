import { useState } from 'react'
import { IconButton } from './IconButton'
import { ShieldMark } from './ShieldMark'
import { PermissionsModal } from './PermissionsModal'

/** チャット見出しの「許可されているもの」。押したときにだけ取りに行く（ポーリングには乗せない） */
export function PermissionsButton({ id }: { id: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton label="このセッションで許可されているものを見る" onClick={() => setOpen(true)}>
        <ShieldMark />
      </IconButton>
      {open && <PermissionsModal id={id} onClose={() => setOpen(false)} />}
    </>
  )
}
