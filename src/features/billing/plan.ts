import { create } from 'zustand'
import { fetchBalance } from '@/api/balanceApi'

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
  /** 'all' — тариф со всеми модулями. Массив — только перечисленные. null — ещё не загружено. */
  modules: string[] | 'all' | null
  planName: string
  load: () => Promise<void>
}

export const usePlan = create<PlanStore>((set) => ({
  modules: null,
  planName: '',
  load: async () => {
    try {
      const b = await fetchBalance()
      set({ modules: b.modules ?? 'all', planName: b.plan.name })
    } catch { /* сеть легла — оставляем как было, а не запираем человека */ }
  },
}))

/**
 * Входит ли модуль в тариф. Пока тариф не загружен — НЕ прячем: иначе при каждом
 * открытии панели меню на секунду схлопывалось бы до пустого.
 */
export function planHasModule(modules: string[] | 'all' | null, moduleKey: string): boolean {
  if (modules === null || modules === 'all') return true
  return modules.includes(moduleKey)
}
