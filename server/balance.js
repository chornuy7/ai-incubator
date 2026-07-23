/**
 * §5.1 SPEC (B2, задел под C2): баланс монет и тарифный план рабочего пространства.
 *
 * До этого план («Базовая»), лимит аккаунтов и монеты были КОНСТАНТАМИ в `src/mocks/seeds.ts`:
 * шапка показывала `80.00` и `5 / 50` независимо от того, что происходило в системе.
 * Здесь появляется единственный источник правды — с него читает шапка, а в C2 на него же
 * сядут списания за действия.
 *
 * Хранение — JSON `data/balance.json`; путь через env BALANCE_FILE (изоляция тестов).
 * Запись идёт через `mutateJson`: списание — операция «прочитал → вычел → записал»,
 * и без сериализации параллельные списания затирали бы друг друга (та же болезнь,
 * что была у accounts-meta).
 */
import { dataPath, readJson, mutateJson } from './lib/jsonStore.js'

const BALANCE_FILE = process.env.BALANCE_FILE || dataPath('balance.json')

/** Тарифы (§5.1). Пока фиксированный список — прайсы заказчик утверждает отдельно. */
export const PLANS = {
  none: { name: 'Нет подписки', accountLimit: 3 },
  basic: { name: 'Базовая', accountLimit: 50 },
  pro: { name: 'Про', accountLimit: 200 },
}

export const DEFAULT_STATE = { planId: 'basic', coins: 0, updatedAt: 0 }

/** Монеты храним с точностью до сотых: списание за действие — доли монеты. */
const normCoins = (v) => Math.max(0, Math.round((Number(v) || 0) * 100) / 100)

/** @returns {Promise<{planId:string, plan:{name:string,accountLimit:number}, coins:number, updatedAt:number}>} */
export async function getBalance() {
  const saved = await readJson(BALANCE_FILE, {})
  const planId = PLANS[saved?.planId] ? saved.planId : DEFAULT_STATE.planId
  return {
    planId,
    plan: PLANS[planId],
    coins: normCoins(saved?.coins ?? DEFAULT_STATE.coins),
    updatedAt: Number(saved?.updatedAt) || 0,
  }
}

/**
 * Пополнить (amount > 0) или списать (amount < 0).
 * Уходить в минус не даём: при нуле боевые модули должны останавливаться (C2),
 * а отрицательный баланс сделал бы это правило непроверяемым.
 * @param {number} amount @param {string} [reason]
 */
export async function changeCoins(amount, reason = '') {
  const delta = Math.round((Number(amount) || 0) * 100) / 100
  let result = null
  await mutateJson(BALANCE_FILE, (cur) => {
    const before = normCoins(cur?.coins ?? DEFAULT_STATE.coins)
    const after = normCoins(before + delta)
    result = { before, after, applied: Math.round((after - before) * 100) / 100, reason }
    return { ...(cur || {}), coins: after, updatedAt: Date.now() }
  })
  return result
}

/** Сменить тариф. @param {string} planId */
export async function setPlan(planId) {
  if (!PLANS[planId]) throw new Error(`Неизвестный тариф: ${planId}`)
  await mutateJson(BALANCE_FILE, (cur) => ({ ...(cur || {}), planId, updatedAt: Date.now() }))
  return getBalance()
}

/** Хватает ли монет на действие — для C2 (стоп боевых модулей при нуле). */
export async function hasCoins(cost = 0) {
  const { coins } = await getBalance()
  return coins >= (Number(cost) || 0)
}
