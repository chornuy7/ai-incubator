/**
 * §5.1 SPEC (B2/C2): баланс монет и тарифный план — У КАЖДОГО ПОЛЬЗОВАТЕЛЯ СВОЙ.
 *
 * Сначала баланс был один на всё рабочее пространство. Владелец уточнил: «у каждого
 * акка должен быть свой баланс» — иначе один клиент тратит монеты другого, и продавать
 * тарифы поштучно невозможно. Ключ хранения — userId; для запросов без сессии (дев,
 * внутренние вызовы) остаётся общий кошелёк `__default`, иначе фоновые списания
 * воркеров падали бы в никуда.
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

// Путь берём функцией, а не константой: константа фиксируется в момент импорта модуля,
// и env, выставленный тестом позже, уже не действует — тест молча писал бы в боевой файл.
const BALANCE_FILE = () => process.env.BALANCE_FILE || dataPath('balance.json')

/** Тарифы (§5.1). Пока фиксированный список — прайсы заказчик утверждает отдельно. */
export const PLANS = {
  none: { name: 'Нет подписки', accountLimit: 3 },
  basic: { name: 'Базовая', accountLimit: 50 },
  pro: { name: 'Про', accountLimit: 200 },
}

export const DEFAULT_STATE = { planId: 'basic', coins: 0, updatedAt: 0 }

/** Кошелёк для запросов без пользователя: дев-режим и фоновые списания воркеров. */
export const DEFAULT_USER = '__default'

/** @param {string} [userId] */
const key = (userId) => String(userId || DEFAULT_USER)

/** Монеты храним с точностью до сотых: списание за действие — доли монеты. */
/**
 * Точность монет — ТЫСЯЧНЫЕ, а не сотые.
 *
 * Было до сотых, и списание за строку парсера (0.005) округлялось вверх до 0.01 —
 * ровно вдвое дороже прайса. Поймано на живом прогоне: 10 строк списали 0.10 вместо
 * 0.05. Пока в прайсе есть цены мельче копейки, хранить баланс с точностью до копейки
 * нельзя: каждое мелкое списание молча дорожает.
 */
const COIN_PRECISION = 1000
const normCoins = (v) => Math.max(0, Math.round((Number(v) || 0) * COIN_PRECISION) / COIN_PRECISION)

/** @returns {Promise<{planId:string, plan:{name:string,accountLimit:number}, coins:number, updatedAt:number}>} */
export async function getBalance(userId) {
  const all = await readJson(BALANCE_FILE(), {})
  // Старый формат — один кошелёк в корне файла. Читаем его как баланс `__default`,
  // чтобы уже начисленные монеты не пропали при переходе на пер-юзерное хранение.
  const legacy = typeof all?.coins === 'number' ? { coins: all.coins, planId: all.planId } : null
  const saved = (all && all[key(userId)]) || (key(userId) === DEFAULT_USER ? legacy : null) || {}
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
export async function changeCoins(amount, reason = '', userId) {
  const delta = Math.round((Number(amount) || 0) * COIN_PRECISION) / COIN_PRECISION
  const k = key(userId)
  let result = null
  await mutateJson(BALANCE_FILE(), (all) => {
    const cur = (all && all[k]) || (k === DEFAULT_USER && typeof all?.coins === 'number' ? { coins: all.coins, planId: all.planId } : {})
    const before = normCoins(cur?.coins ?? DEFAULT_STATE.coins)
    const after = normCoins(before + delta)
    result = { before, after, applied: Math.round((after - before) * COIN_PRECISION) / COIN_PRECISION, reason, userId: k }
    const next = { ...(all || {}) }
    delete next.coins; delete next.planId; delete next.updatedAt // чистим старый корневой формат
    next[k] = { ...cur, coins: after, updatedAt: Date.now() }
    return next
  })
  return result
}

/** Сменить тариф. @param {string} planId */
export async function setPlan(planId, userId) {
  if (!PLANS[planId]) throw new Error(`Неизвестный тариф: ${planId}`)
  const k = key(userId)
  await mutateJson(BALANCE_FILE(), (all) => {
    const next = { ...(all || {}) }
    delete next.coins; delete next.planId; delete next.updatedAt
    next[k] = { ...(next[k] || {}), planId, updatedAt: Date.now() }
    return next
  })
  return getBalance(userId)
}

/** Хватает ли монет на действие — для C2 (стоп боевых модулей при нуле). */
export async function hasCoins(cost = 0, userId) {
  const { coins } = await getBalance(userId)
  return coins >= (Number(cost) || 0)
}
