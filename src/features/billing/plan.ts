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

export const usePlan = create<PlanStore>((set) => ({
  modules: null,
  load: async () => {
    // Роль «без оплаты» (тест/модератор) видит все модули в обход подписки: доступ
    // ограничивает роль, а не кошелёк. Зеркалит серверный обход в modules/routes.js.
    if (useSession.getState().user?.permissions?.freeAccess) { set({ modules: 'all' }); return }
    try {
      const b = await fetchBalance()
      set({ modules: b.modules ?? 'all' })
    } catch { /* сеть легла — оставляем как было, а не запираем человека */ }
  },
}))

/**
 * Оплачен ли модуль. Пока подписка не загружена — НЕ прячем: иначе при каждом
 * открытии панели меню на секунду схлопывалось бы до пустого.
 */
export function planHasModule(modules: string[] | 'all' | null, moduleKey: string): boolean {
  if (modules === null || modules === 'all') return true
  return modules.includes(moduleKey)
}
