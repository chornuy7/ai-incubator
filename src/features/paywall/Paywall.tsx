import { type ReactNode } from 'react'
import { Lock, Sparkles, Check, ArrowRight } from 'lucide-react'
import { useApp } from '@/mocks/store'

const PERKS = [
  'До 50 Telegram-аккаунтов',
  'Все модули автоматизации',
  'Парсеры каналов, групп и аудитории',
  'GGR-рейтинг и аудит сетки',
]

/** Баннер в шапке контента для сценария no-sub. */
export function PaywallBanner() {
  const pushToast = useApp((s) => s.pushToast)
  const setUserState = useApp((s) => s.setUserState)
  return (
    <div className="mb-5 flex flex-col items-start gap-4 overflow-hidden rounded-2xl border border-iris-500/40 bg-iris-500/8 p-5 sm:flex-row sm:items-center">
      <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-iris-gradient">
        <Sparkles size={22} className="text-white" />
      </div>
      <div className="flex-1">
        <div className="font-display text-lg font-bold text-fg">Подписка не активна</div>
        <div className="text-sm text-muted">Оформите тариф, чтобы разблокировать все модули и лимиты AI Incubator.</div>
      </div>
      <div className="flex gap-2">
        <button onClick={() => setUserState('with-data')} className="btn-ghost h-10">Демо-доступ</button>
        <button
          onClick={() => pushToast({ type: 'info', title: 'Оплата в демо отключена', desc: 'Оформление тарифа — только визуал.' })}
          className="btn-iris h-10"
        >
          Оформить <ArrowRight size={16} />
        </button>
      </div>
    </div>
  )
}

/** Оверлей поверх заблокированного контента (blur + CTA). */
export function PaywallLock({ children }: { children: ReactNode }) {
  const pushToast = useApp((s) => s.pushToast)
  return (
    <div className="relative">
      <div className="pointer-events-none select-none blur-[3px] saturate-50">{children}</div>
      <div className="absolute inset-0 grid place-items-center rounded-2xl bg-bg/40 backdrop-blur-[2px]">
        <div className="max-w-sm rounded-2xl border border-line bg-surface/95 p-6 text-center shadow-pop">
          <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl border border-iris-500/40 bg-iris-500/10">
            <Lock size={26} className="text-iris-300" />
          </div>
          <h3 className="font-display text-lg font-bold text-fg">Модуль заблокирован</h3>
          <p className="mt-1 text-sm text-muted">Доступно на активной подписке. Оформите тариф, чтобы продолжить.</p>
          <ul className="mx-auto mt-4 space-y-1.5 text-left">
            {PERKS.map((p) => (
              <li key={p} className="flex items-center gap-2 text-sm text-fg">
                <Check size={15} className="shrink-0 text-spark-400" /> {p}
              </li>
            ))}
          </ul>
          <button
            onClick={() => pushToast({ type: 'info', title: 'Оплата в демо отключена', desc: 'Только визуал.' })}
            className="btn-iris mt-5 h-10 w-full"
          >
            Оформить подписку <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
