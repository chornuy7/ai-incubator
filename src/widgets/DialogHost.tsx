import { useEffect, useState } from 'react'
import { AlertTriangle, HelpCircle, Pencil } from 'lucide-react'
import { Modal } from '@/shared/ui'
import { useDialog } from '@/shared/lib/dialog'

/** Единый рендер модальных диалогов (confirm/prompt) поверх приложения. Мьётся один раз в Layout. */
export function DialogHost() {
  const current = useDialog((s) => s.current)
  const resolve = useDialog((s) => s.resolveCurrent)
  const [value, setValue] = useState('')

  useEffect(() => {
    if (current?.kind === 'prompt') setValue(current.defaultValue ?? '')
  }, [current])

  if (!current) return null

  const isPrompt = current.kind === 'prompt'
  const danger = current.kind === 'confirm' && current.tone === 'danger'
  const cancel = () => resolve(isPrompt ? null : false)
  const submit = () => resolve(isPrompt ? (value.trim() || null) : true)

  const icon = isPrompt
    ? <Pencil size={20} />
    : danger
      ? <AlertTriangle size={20} className="text-rose-400" />
      : <HelpCircle size={20} />

  return (
    <Modal
      open
      onClose={cancel}
      size="sm"
      title={current.title}
      icon={icon}
      footer={
        <>
          <button type="button" onClick={cancel} className="btn-ghost h-10">{current.cancelLabel ?? 'Отмена'}</button>
          <button
            type="button"
            onClick={submit}
            disabled={isPrompt && !value.trim()}
            className={`${danger ? 'btn-danger' : 'btn-primary'} h-10 disabled:opacity-40`}
          >
            {current.confirmLabel ?? (isPrompt ? 'Сохранить' : danger ? 'Удалить' : 'Подтвердить')}
          </button>
        </>
      }
    >
      {current.message && <p className="whitespace-pre-line text-sm text-muted">{current.message}</p>}
      {isPrompt && (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) submit() }}
          placeholder={current.placeholder}
          className="input mt-3 h-11 w-full"
        />
      )}
    </Modal>
  )
}
