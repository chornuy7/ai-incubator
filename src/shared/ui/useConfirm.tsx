import { useRef, useState, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Modal } from './Modal'

interface ConfirmOpts {
  title?: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** 'danger' — красная кнопка подтверждения (необратимые/боевые действия). */
  tone?: 'danger' | 'primary'
}

/**
 * Промис-подтверждение стильной модалкой вместо нативного window.confirm.
 * const { confirm, confirmEl } = useConfirm()
 * if (!(await confirm({ message: '…' }))) return
 * … и отрендерить {confirmEl} в разметке.
 */
export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null)
  const resolver = useRef<((v: boolean) => void) | null>(null)

  const confirm = (o: ConfirmOpts) =>
    new Promise<boolean>((resolve) => {
      resolver.current = resolve
      setOpts(o)
    })

  const settle = (v: boolean) => {
    resolver.current?.(v)
    resolver.current = null
    setOpts(null)
  }

  const confirmEl = (
    <Modal open={!!opts} onClose={() => settle(false)} title={opts?.title ?? 'Подтверждение'} icon={<AlertTriangle size={22} />} size="sm">
      {opts && (
        <div className="space-y-5">
          <div className="text-sm leading-relaxed text-muted">{opts.message}</div>
          <div className="flex justify-end gap-2">
            <button onClick={() => settle(false)} className="btn-ghost h-10">{opts.cancelLabel ?? 'Отмена'}</button>
            <button onClick={() => settle(true)} className={`${opts.tone === 'danger' ? 'btn-danger' : 'btn-primary'} h-10`}>
              {opts.confirmLabel ?? 'Продолжить'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )

  return { confirm, confirmEl }
}
