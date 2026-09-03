import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/shared/lib/utils'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  icon?: ReactNode
  /**
   * Боковая панель вместо окна по центру: выезжает от правого края во всю высоту.
   * Так открываются карточки аккаунтов — попап посреди экрана для них неудобен,
   * панель не закрывает список и читается как «деталь выбранной строки».
   */
  side?: boolean
}

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }

export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md', icon, side }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className={cn(
      'fixed inset-0 z-[100] flex p-0',
      side ? 'items-stretch justify-end' : 'items-end justify-center sm:items-center sm:p-4',
    )}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div
        className={cn(
          'relative z-10 flex w-full flex-col overflow-hidden border border-line bg-surface shadow-pop',
          side
            // Панель: во всю высоту у правого края, скругление только слева.
            ? 'h-full max-w-xl rounded-l-3xl animate-slide-in-right'
            : cn('max-h-[92vh] rounded-t-3xl animate-scale-in sm:rounded-3xl', SIZES[size]),
        )}
      >
        {(title || icon) && (
          <div className="flex items-start gap-3 border-b border-line px-5 py-4">
            {icon && <div className="mt-0.5 shrink-0 text-spark-400">{icon}</div>}
            <div className="min-w-0 flex-1">
              {title && <h3 className="font-display text-lg font-bold text-fg">{title}</h3>}
              {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
            </div>
            <button onClick={onClose} className="btn-icon shrink-0" aria-label="Закрыть">
              <X size={18} />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-elevated/60 px-5 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
