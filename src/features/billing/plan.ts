import { create } from 'zustand'
import { fetchBalance } from '@/api/balanceApi'
import { useSession } from '@/features/auth/session'

/**
 * Что клиент КУПИЛ — отдельная ось от того, что ему разрешил админ.
 *
 * Заказчик (23.07): «людина хоче купити тільки нейрочатинг — купляє, і їй
 * показується нейрочатінг». То есть тариф не просто отказывает на запуске: не
 * купленный модуль вообще не должен маячить в меню. Роль (RBAC) отвечает на вопрос
 * «что сотруднику разрешил админ», тариф — «что оплачено»; проходить надо обе.
 *
 * Держим отдельным стором, а не полем сессии: тариф меняется оплатой, а не входом,
 * и обновляться должен сам — как и права (см. session.refresh).
 */
interface PlanStore {
  /** 'all' — подписка на все модули. Массив — только перечисленные. null — ещё не загружено. */
  modules: string[] | 'all' | null
  load: () => Promise<void>
}

/**
 * Кэш набора модулей в браузере — чтобы меню не «моргало» на каждом входе.
 *
 * Ответ про подписку приходит через сотни миллисекунд после первого рендера. Пока его
 * нет, набор неизвестен, и меню приходится либо показывать целиком (тогда лишние пункты
 * на глазах исчезают — то самое мигание), либо не показывать вовсе (тогда оно
 * «доезжает»). Кэш убирает выбор: показываем ровно то, что было в прошлый раз, а ответ
 * сервера его подтверждает или поправляет.
 *
 * Ключ привязан к пользователю: чужой набор не должен мелькнуть при смене аккаунта.
 */
const CACHE_KEY = 'ai-incubator:plan'
const cacheKeyFor = (userId?: string) => `${CACHE_KEY}:${userId || 'anon'}`

function readCache(): string[] | 'all' | null {
  try {
    const raw = localStorage.getItem(cacheKeyFor(useSession.getState().user?.id))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed === 'all' || Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

function writeCache(modules: string[] | 'all') {
  try { localStorage.setItem(cacheKeyFor(useSession.getState().user?.id), JSON.stringify(modules)) } catch { /* quota */ }
}

export const usePlan = create<PlanStore>((set) => ({
  modules: readCache(),
  load: async () => {
    // Роль «без оплаты» (тест/модератор) видит все модули в обход подписки: доступ
    // ограничивает роль, а не кошелёк. Зеркалит серверный обход в modules/routes.js.
    if (useSession.getState().user?.permissions?.freeAccess) { set({ modules: 'all' }); writeCache('all'); return }
    try {
      const b = await fetchBalance()
      const modules = b.modules ?? 'all'
      set({ modules })
      writeCache(modules)
    } catch { /* сеть легла — оставляем как было, а не запираем человека */ }
  },
}))

/**
 * Оплачен ли модуль.
 *
 * Правка 18.08. Раньше неизвестный набор (`null`) означал «показываем» — и на входе
 * человек видел ВЕСЬ список модулей, который через мгновение схлопывался до купленного.
 * Выглядело это как подмена интерфейса на глазах. Теперь неизвестный набор ничего не
 * открывает, а чтобы меню не «доезжало» на каждом входе, стартовое значение берётся из
 * кэша прошлой загрузки (см. выше).
 */
export function planHasModule(modules: string[] | 'all' | null, moduleKey: string): boolean {
  if (modules === 'all') return true
  if (modules === null) return false
  return modules.includes(moduleKey)
}
