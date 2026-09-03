import { create } from 'zustand'
import { type Balance } from '@/api/balanceApi'
import { useBalanceStore, refreshBalance } from '@/features/billing/balanceStore'
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
  /**
   * Срок подписки (§5, 21.08). `null` — БЕССРОЧНО, а не «истекло»: так живут дефолтное
   * пространство и демо без периода, и путать эти два состояния нельзя — иначе меню
   * схлопнется у тех, кому оно открыто навсегда.
   */
  expiresAt: number | null
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

interface CachedPlan { modules: string[] | 'all' | null; expiresAt: number | null }

function readCache(): CachedPlan {
  try {
    const raw = localStorage.getItem(cacheKeyFor(useSession.getState().user?.id))
    if (!raw) return { modules: null, expiresAt: null }
    const parsed = JSON.parse(raw)
    // Старый формат кэша — голый набор без срока. Читаем как бессрочный: срок
    // приедет с первым же ответом сервера, а ронять меню из-за формата незачем.
    if (parsed === 'all' || Array.isArray(parsed)) return { modules: parsed, expiresAt: null }
    if (parsed && typeof parsed === 'object' && (parsed.modules === 'all' || Array.isArray(parsed.modules))) {
      return { modules: parsed.modules, expiresAt: Number(parsed.expiresAt) || null }
    }
    return { modules: null, expiresAt: null }
  } catch { return { modules: null, expiresAt: null } }
}

function writeCache(modules: string[] | 'all', expiresAt: number | null) {
  try { localStorage.setItem(cacheKeyFor(useSession.getState().user?.id), JSON.stringify({ modules, expiresAt })) } catch { /* quota */ }
}

const cached = readCache()

export const usePlan = create<PlanStore>(() => ({
  modules: cached.modules,
  expiresAt: cached.expiresAt,
  load: async () => {
    // Роль «без оплаты» (тест/модератор) видит все модули в обход подписки: доступ
    // ограничивает роль, а не кошелёк. Зеркалит серверный обход в modules/routes.js.
    // Срока у такого доступа нет — он не куплен, а выдан.
    if (useSession.getState().user?.permissions?.freeAccess) {
      usePlan.setState({ modules: 'all', expiresAt: null })
      writeCache('all', null)
      return
    }
    // MR-151: набор модулей приезжает в том же `/api/balance`, что и монеты, поэтому
    // своего запроса тут больше нет — берём общий (см. balanceStore). Результат
    // применяет подписка ниже, одинаково и для этого вызова, и для фонового тика.
    await refreshBalance()
  },
}))

/** Разложить ответ баланса на «что куплено» и «до какого числа». */
function applyBalance(b: Balance | null) {
  if (!b) return
  // Роль сильнее кошелька — и проверяем её на КАЖДОМ тике: права перечитываются
  // фоном (session.refresh), и выданный админом freeAccess должен открыть меню в
  // текущей сессии, а не «после перезахода».
  if (useSession.getState().user?.permissions?.freeAccess) {
    usePlan.setState({ modules: 'all', expiresAt: null })
    writeCache('all', null)
    return
  }
  const modules = b.modules ?? 'all'
  const expiresAt = Number(b.expiresAt) || null
  usePlan.setState({ modules, expiresAt })
  writeCache(modules, expiresAt)
}

// Один общий поллер баланса обновляет и подписку: оплатили модуль — он появляется
// в меню сам, без второго запроса тем же тиком.
useBalanceStore.subscribe((s, prev) => { if (s.balance !== prev.balance) applyBalance(s.balance) })

/**
 * Истёк ли срок подписки. `null`/`0` — бессрочно (см. PlanStore.expiresAt).
 * Зеркало серверного `subscriptionExpired` (server/balance.js).
 */
export function planExpired(expiresAt?: number | null): boolean {
  const t = Number(expiresAt) || 0
  return t > 0 && t <= Date.now()
}

/**
 * Оплачен ли модуль.
 *
 * Правка 18.08. Раньше неизвестный набор (`null`) означал «показываем» — и на входе
 * человек видел ВЕСЬ список модулей, который через мгновение схлопывался до купленного.
 * Выглядело это как подмена интерфейса на глазах. Теперь неизвестный набор ничего не
 * открывает, а чтобы меню не «доезжало» на каждом входе, стартовое значение берётся из
 * кэша прошлой загрузки (см. выше).
 *
 * Правка 21.08 (§5). Третий аргумент — срок подписки, как у серверного `modulesAllow`.
 * Он необязателен СОЗНАТЕЛЬНО: «куплен ли модуль» и «действует ли оплата» — разные
 * вопросы, и витрине (страница «Подписки») нужен только первый. Гейты доступа обязаны
 * передавать срок: без него подписка считается бессрочной, и просроченный модуль
 * оставался в меню до первой 403 с сервера.
 */
export function planHasModule(modules: string[] | 'all' | null, moduleKey: string, expiresAt?: number | null): boolean {
  if (planExpired(expiresAt)) return false
  if (modules === 'all') return true
  if (modules === null) return false
  return modules.includes(moduleKey)
}
