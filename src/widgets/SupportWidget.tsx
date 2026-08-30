import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LifeBuoy, X, Plus, MessagesSquare, Send } from 'lucide-react'
import { fetchTicketsUnread } from '@/api/ticketsApi'
import { useSession } from '@/features/auth/session'

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
  /**
   * MR-249: непрочитанное подписано СЛОВАМИ. Заказчик 30.08: «если там будет точка, я
   * может быть и не замечу сразу. А слово я точно замечу». Точку на кружке и правда
   * невозможно поймать взглядом — особенно на странице, где и без неё десяток значков.
   */
  const [непрочитанных, setНепрочитанных] = useState(0)
  const [скрыто, setСкрыто] = useState(false)
  const isSub = useSession((s) => s.user?.isSub)
  const nav = useNavigate()
  const go = (to: string) => { setOpen(false); nav(to) }

  useEffect(() => {
    let alive = true
    const tick = async () => {
      // Вкладка свёрнута — не дёргаем сервер: это фоновая проверка, а не работа.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      try { const n = await fetchTicketsUnread(); if (alive) setНепрочитанных(n) } catch { /* offline — молча */ }
    }
    void tick()
    const iv = setInterval(tick, 30000)
    return () => { alive = false; clearInterval(iv) }
  }, [])

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
      {/*
        Подсказка слева от кружка: прямоугольник со стрелкой и текстом. Закрывается
        крестиком — навязчивая плашка, которую нельзя убрать, раздражает сильнее точки.
      */}
      {!open && непрочитанных > 0 && !скрыто && (
        <div className="relative mb-1 flex items-center gap-2 rounded-xl border border-spark-500/40 bg-spark-500/12 py-1.5 pl-3 pr-2 text-xs font-semibold text-spark-200 shadow-lg shadow-black/30">
          <button type="button" onClick={() => go('/panel/support')} className="hover:underline">
            {непрочитанных} {непрочитанных === 1 ? 'пропущенное сообщение' : непрочитанных < 5 ? 'пропущенных сообщения' : 'пропущенных сообщений'}
          </button>
          <button type="button" onClick={() => setСкрыто(true)} aria-label="Скрыть" className="text-spark-200/60 hover:text-spark-100"><X size={13} /></button>
          {/* Стрелка на кружок — чтобы подсказка читалась как относящаяся именно к нему. */}
          <span className="absolute -bottom-1 right-4 h-2 w-2 rotate-45 border-b border-r border-spark-500/40 bg-spark-500/12" />
        </div>
      )}

      {open && (
        <div className="w-64 origin-bottom-right rounded-2xl border border-line bg-elevated/95 p-3 shadow-lg shadow-black/40 backdrop-blur">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-fg"><LifeBuoy size={15} className="text-spark-400" /> Поддержка</span>
            <button type="button" onClick={() => setOpen(false)} className="text-muted hover:text-fg" aria-label="Закрыть"><X size={15} /></button>
          </div>
          <p className="mb-3 text-xs text-muted">
            {isSub
              ? 'Ваши обращения уходят администратору пространства — он выдаёт доступы, аккаунты и токены.'
              : 'Мы на связи. Опишите вопрос — команда ответит в течение суток.'}
          </p>
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
        className="relative grid h-10 w-10 place-items-center rounded-full bg-spark-gradient text-[#04150c] shadow-pop transition-transform hover:scale-[1.05]"
        aria-label="Поддержка"
        title="Поддержка"
      >
        {open ? <X size={18} /> : <LifeBuoy size={18} />}
        {!open && непрочитанных > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">{непрочитанных}</span>
        )}
      </button>
    </div>
  )
}
