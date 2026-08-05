import { type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Lock, Sparkles, Check, ArrowRight } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { usePlan } from '@/features/billing/plan'

/** §2 (MR-20): у подписчика (есть набор модулей) блок — «апгрейд/добавить», а не «оформить». */
function useSubState() {
  const planModules = usePlan((s) => s.modules)
  return { hasSub: Array.isArray(planModules) && planModules.length > 0 }
}

const PERKS = [
  'До 50 Telegram-аккаунтов',
  'Все модули автоматизации',
  'Парсеры каналов, групп и аудитории',
  'AIR — AI-рейтинг и аудит сетки',
]

/** Баннер в шапке контента для сценария no-sub. */
export function PaywallBanner() {
  const setUserState = useApp((s) => s.setUserState)
  const nav = useNavigate()
  const { hasSub } = useSubState()
  return (
    <div className="mb-5 flex flex-col items-start gap-4 overflow-hidden rounded-2xl border border-iris-500/40 bg-iris-500/8 p-5 sm:flex-row sm:items-center">
      <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-iris-gradient">
        <Sparkles size={22} className="text-white" />
      </div>
      <div className="flex-1">
        <div className="font-display text-lg font-bold text-fg">{hasSub ? 'Расширьте подписку' : 'Подписка не активна'}</div>
        <div className="text-sm text-muted">{hasSub ? 'Добавьте модули к вашему набору — доступ откроется сразу.' : 'Оформите тариф, чтобы разблокировать модули и лимиты Murmex.'}</div>
      </div>
      <div className="flex gap-2">
        <button onClick={() => setUserState('with-data')} className="btn-ghost h-10">Демо-доступ</button>
        {/* §2 (MR-19): единый CTA — ведёт на страницу подписки, а не в тупиковый тост. */}
        <button onClick={() => nav('/panel/user/subscription')} className="btn-iris h-10">
          {hasSub ? 'Добавить модули' : 'Оформить'} <ArrowRight size={16} />
        </button>
      </div>
    </div>
  )
}

/** Оверлей поверх заблокированного контента (blur + CTA). */
export function PaywallLock({ children }: { children: ReactNode }) {
  const nav = useNavigate()
  const { hasSub } = useSubState()
  return (
    <div className="relative">
      <div className="pointer-events-none select-none blur-[3px] saturate-50">{children}</div>
      <div className="absolute inset-0 grid place-items-center rounded-2xl bg-bg/40 backdrop-blur-[2px]">
        <div className="max-w-sm rounded-2xl border border-line bg-surface/95 p-6 text-center shadow-pop">
          <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl border border-iris-500/40 bg-iris-500/10">
            <Lock size={26} className="text-iris-300" />
          </div>
          {/* §2.2 (MR-20): у подписчика — «нет в наборе»/«добавить», у остальных — «оформить». */}
          <h3 className="font-display text-lg font-bold text-fg">{hasSub ? 'Модуль не в вашем наборе' : 'Модуль заблокирован'}</h3>
          <p className="mt-1 text-sm text-muted">{hasSub ? 'Он не входит в вашу подписку. Добавьте его — доступ откроется сразу.' : 'Доступно на активной подписке. Оформите тариф, чтобы продолжить.'}</p>
          <ul className="mx-auto mt-4 space-y-1.5 text-left">
            {PERKS.map((p) => (
              <li key={p} className="flex items-center gap-2 text-sm text-fg">
                <Check size={15} className="shrink-0 text-spark-400" /> {p}
              </li>
            ))}
          </ul>
          {/* §2 (MR-19): единый CTA — ведёт на страницу подписки (было — тупиковый тост). */}
          <button onClick={() => nav('/panel/user/subscription')} className="btn-iris mt-5 h-10 w-full">
            {hasSub ? 'Добавить модуль' : 'Оформить подписку'} <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
