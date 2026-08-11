import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LifeBuoy, X, Plus, MessagesSquare, Send } from 'lucide-react'

/**
 * §8 (MR-45): быстрый виджет поддержки в правом нижнем углу — доступен с любой страницы.
 *
 * Раньше в поддержку можно было попасть только через пункт меню «Поддержка». Виджет даёт
 * быстрый вход: открыть новый тикет или список обращений, не ища раздел. Сам тикет
 * создаётся на странице поддержки (единый источник — там же переписка и статусы).
 * Отдельно от кнопки Help Center (справка по функциям) — это про связь с командой.
 */
export function SupportWidget() {
  const [open, setOpen] = useState(false)
  const nav = useNavigate()
  const go = (to: string) => { setOpen(false); nav(to) }

  return (
    // bottom считаем от высоты нижней панели запуска (её публикует FloatingBar):
    // на страницах модулей виджет поднимается над панелью, на остальных — стоит внизу.
    <div
      style={{ bottom: 'calc(var(--launch-bar-h, 0px) + 1.25rem)', right: 'clamp(1rem, calc((100vw - var(--sidebar-w, 0px) - 1400px) / 2 - 1rem), 4rem)' }}
      // z выше кнопки Help Center (97): раскрытая карточка поддержки растёт вверх и
      // попадала ровно на неё — «?» торчал поверх содержимого. Теперь Help уходит под
      // карточку, а закроешь её — снова доступен. Ниже модалок (100) и тостов (200).
      className="fixed z-[98] flex flex-col items-end gap-2 print:hidden"
    >
      {open && (
        <div className="w-64 origin-bottom-right rounded-2xl border border-line bg-elevated/95 p-3 shadow-lg shadow-black/40 backdrop-blur">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-fg"><LifeBuoy size={15} className="text-spark-400" /> Поддержка</span>
            <button type="button" onClick={() => setOpen(false)} className="text-muted hover:text-fg" aria-label="Закрыть"><X size={15} /></button>
          </div>
          <p className="mb-3 text-xs text-muted">Мы на связи. Опишите вопрос — команда ответит в течение суток.</p>
          <div className="flex flex-col gap-2">
            <button type="button" onClick={() => go('/panel/support?new=1')} className="btn-primary h-9 justify-center text-sm"><Plus size={15} /> Новый тикет</button>
            <button type="button" onClick={() => go('/panel/support')} className="btn-ghost h-9 justify-center text-sm"><MessagesSquare size={15} /> Мои обращения</button>
            <button type="button" onClick={() => go('/panel/support')} className="btn-ghost h-9 justify-center text-sm"><Send size={15} /> Написать в Telegram</button>
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="grid h-10 w-10 place-items-center rounded-full bg-spark-gradient text-[#04150c] shadow-pop transition-transform hover:scale-[1.05]"
        aria-label="Поддержка"
        title="Поддержка"
      >
        {open ? <X size={18} /> : <LifeBuoy size={18} />}
      </button>
    </div>
  )
}
