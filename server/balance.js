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
/**
 * Тарифы — только лимит аккаунтов. Набор модулей клиент СОБИРАЕТ сам (см. ниже).
 *
 * Заказчик (23.07): «людина хоче нейрочатінг + мейлінг — вибирає собі модулі які
 * хоче, сума сумується і оплачується в кабінеті, доступ тільки до них». Поэтому
 * фиксированных коробок «Базовая / Про» с зашитым набором модулей быть не может:
 * набор — это выбор клиента, а не одна из трёх заготовок.
 */
export const PLANS = {
  none: { name: 'Нет подписки', accountLimit: 3 },
  basic: { name: 'Базовая', accountLimit: 50 },
  pro: { name: 'Про', accountLimit: 200 },
}

/**
 * Что открыто, пока набор не выбран.
 *
 * `'all'` — а не пустой список: система уже работает у существующих клиентов, и
 * молча закрыть им всё в момент выкатки — худший способ ввести подписки. Ограничение
 * начинает действовать с той секунды, когда набор выбран явно.
 */
export const DEFAULT_MODULES = 'all'

/**
 * Ключ подписки. Она принадлежит РАБОЧЕМУ ПРОСТРАНСТВУ, а не человеку: платит
 * владелец, а сотрудники работают внутри купленного. Пока хранили пер-юзерно,
 * у сотрудника не было своей записи — и он получал `'all'`, то есть все 14 модулей
 * при оплаченных двух. Монеты при этом остаются пер-юзерными: за расход платит тот,
 * кто запускает.
 */
const SUBSCRIPTION_KEY = '__subscription'

/**
 * Открыт ли модуль этому набору. Набор — либо `'all'`, либо список ключей.
 * @param {string[]|'all'|undefined} modules @param {string} moduleKey
 */
export function modulesAllow(modules, moduleKey) {
  if (modules === 'all' || modules == null) return true
  return Array.isArray(modules) && modules.includes(moduleKey)
}

/**
 * Записать набор купленных модулей. Одна запись на всё пространство: подписку
 * оплачивает владелец, и у сотрудника не должно быть своей.
 * @param {string[]|'all'} modules @param {string} [userId] чей баланс вернуть в ответе
 */
export async function setModules(modules, userId) {
  const list = modules === 'all' ? 'all' : [...new Set((modules || []).map(String).filter(Boolean))]
  await mutateJson(BALANCE_FILE(), (all) => {
    const next = { ...(all || {}) }
    delete next.coins; delete next.planId; delete next.updatedAt
    next[SUBSCRIPTION_KEY] = { modules: list, updatedAt: Date.now() }
    return next
  })
  return getBalance(userId)
}

export const DEFAULT_STATE = { planId: 'basic', coins: 0, updatedAt: 0 }

/** Кошелёк для запросов без пользователя: дев-режим и фоновые списания воркеров. */
export const DEFAULT_USER = '__default'

/** @param {string} [userId] */
const key = (userId) => String(userId || DEFAULT_USER)

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
    // Набор купленных модулей — общий на пространство (см. SUBSCRIPTION_KEY).
    modules: (all && all[SUBSCRIPTION_KEY]?.modules) ?? DEFAULT_MODULES,
    coins: normCoins(saved?.coins ?? DEFAULT_STATE.coins),
    updatedAt: Number(saved?.updatedAt) || 0,
  }
}

/**
 * Свод по всем кошелькам пространства: сколько монет у всех пользователей вместе.
 *
 * Нужен админ-панели. После перехода на пер-юзерные кошельки `getBalance()` без id
 * стал возвращать пустой `__default`, и в статистике висел ноль вместо реальной
 * суммы. Служебные ключи (`__subscription`, `__default`) в подсчёт не идут.
 * @returns {Promise<{coins:number, wallets:number}>}
 */
export async function totalCoins() {
  const all = await readJson(BALANCE_FILE(), {})
  let coins = 0
  let wallets = 0
  let service = 0
  for (const [k, v] of Object.entries(all || {})) {
    if (k === SUBSCRIPTION_KEY) continue
    if (typeof v?.coins !== 'number') continue
    // Служебный кошелёк (`__default`) считаем ОТДЕЛЬНО: он не принадлежит человеку,
    // и, попадая в общую сумму, разводил её с итогом «На счету» в таблице людей.
    if (k === DEFAULT_USER) { service = v.coins; continue }
    coins = Math.round((coins + v.coins) * COIN_PRECISION) / COIN_PRECISION
    wallets += 1
  }
  return { coins, wallets, service }
}

/**
 * Монеты по каждому кошельку: id пользователя → сколько у него сейчас.
 *
 * Нужен админ-панели: после перехода на личные кошельки общая сумма отвечает
 * «сколько всего», но не «у кого». Служебные ключи не отдаём — это не люди.
 * @returns {Promise<Record<string, number>>}
 */
export async function coinsByUser() {
  const all = await readJson(BALANCE_FILE(), {})
  const out = {}
  for (const [k, v] of Object.entries(all || {})) {
    if (k === SUBSCRIPTION_KEY || k === DEFAULT_USER) continue
    if (typeof v?.coins === 'number') out[k] = v.coins
  }
  return out
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
  // История пишется ПОСЛЕ успешного изменения и не роняет операцию при сбое:
  // потерянная строка журнала — досадно, потерянное списание — деньги.
  if (result && result.applied) await appendWalletEntry(result).catch(() => {})
  return result
}

/**
 * Журнал операций по кошелькам — `data/wallet-log.jsonl`, строка на операцию.
 *
 * Без него на вопрос клиента «за что списали 12 монет» ответить нечем: баланс
 * показывает только «сколько сейчас». JSONL, а не JSON-массив: дописывание строки
 * не перечитывает весь файл и не теряет историю при параллельных списаниях.
 */
const WALLET_LOG = () => process.env.WALLET_LOG_FILE || dataPath('wallet-log.jsonl')

async function appendWalletEntry(entry) {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const file = WALLET_LOG()
  await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {})
  const row = {
    ts: Date.now(),
    userId: entry.userId,
    amount: entry.applied,
    before: entry.before,
    after: entry.after,
    reason: String(entry.reason || ''),
  }
  await fs.appendFile(file, JSON.stringify(row) + '\n', 'utf8')
}

/**
 * Операции по кошельку: свежие сверху. Без userId — по всем (для админки).
 * @param {{userId?:string, limit?:number, since?:number}} [filter]
 */
export async function walletHistory(filter = {}) {
  const fs = await import('node:fs/promises')
  let raw = ''
  try { raw = await fs.readFile(WALLET_LOG(), 'utf8') } catch { return [] }
  const limit = Math.min(1000, Math.max(1, Number(filter.limit) || 100))
  const since = Number(filter.since) || 0
  const wanted = filter.userId ? key(filter.userId) : null

  const rows = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (wanted && r.userId !== wanted) continue
      if (since && (Number(r.ts) || 0) < since) continue
      rows.push(r)
    } catch { /* битая строка не должна ронять весь журнал */ }
  }
  return rows.reverse().slice(0, limit)
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
