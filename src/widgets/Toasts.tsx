import { createPortal } from 'react-dom'
import { CheckCircle2, XCircle, Info, X } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { cn } from '@/shared/lib/utils'

const ICONS = {
  success: <CheckCircle2 size={18} className="text-spark-400" />,
  error: <XCircle size={18} className="text-rose-400" />,
  info: <Info size={18} className="text-iris-400" />,
}
const BORDERS = {
  success: 'border-l-spark-500',
  error: 'border-l-rose-500',
  info: 'border-l-iris-500',
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)

  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[200] flex w-full max-w-sm flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex items-start gap-3 rounded-xl border border-l-4 border-line bg-surface p-3.5 shadow-pop animate-fade-in',
            BORDERS[t.type],
          )}
        >
          <div className="mt-0.5 shrink-0">{ICONS[t.type]}</div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-fg">{t.title}</div>
            {t.desc && <div className="mt-0.5 text-xs text-muted">{t.desc}</div>}
          </div>
          <button onClick={() => dismiss(t.id)} className="shrink-0 text-faint transition-colors hover:text-fg">
            <X size={15} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}
