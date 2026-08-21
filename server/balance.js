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
import { getSupabase, supabaseEnabled } from './lib/supabase.js'
import { resolveWalletOwner, resolveSubscriptionOwner } from './users.js'

/**
 * §10.2: когда DATA_BACKEND=supabase, баланс/подписки/журнал живут в БД, а не в
 * файле. Гейт — `sb()`: возвращает клиента только если включён Supabase и он
 * сконфигурирован; иначе null → работает файловый путь (и все тесты на файлах).
 */
function sb() { return supabaseEnabled() ? getSupabase() : null }
const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null)
const ms = (t) => (t ? new Date(t).getTime() : 0)

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
 * Истёк ли срок подписки. `null`/`undefined`/`0` — БЕССРОЧНО (так живёт дефолтный
 * воркспейс и демо без периода), и закрывать такую подписку нельзя.
 *
 * Баг 19.08 (§2): срок хранился (`expiresAt`, `expires_at`), но не проверялся нигде —
 * оплаченный на месяц модуль работал вечно. Дата — единственный источник правды о том,
 * действует ли подписка; отдельного флага «активна» намеренно не заводим, иначе
 * появился бы второй источник, который надо кем-то гасить по расписанию.
 * @param {number|null|undefined} expiresAt
 */
export function subscriptionExpired(expiresAt) {
  const t = Number(expiresAt) || 0
  return t > 0 && t <= Date.now()
}

/**
 * Сколько дней назад истекла подписка — для текста отказа («истекла 3 дня назад»).
 * Меньше суток — 0, отказ говорит «сегодня».
 * @param {number|null|undefined} expiresAt
 */
export function daysSinceExpiry(expiresAt) {
  const t = Number(expiresAt) || 0
  if (!t) return 0
  return Math.max(0, Math.floor((Date.now() - t) / DAY))
}

/**
 * Открыт ли модуль этому набору. Набор — либо `'all'`, либо список ключей.
 *
 * Третий аргумент — срок подписки. Он необязателен СОЗНАТЕЛЬНО: вопрос «куплен ли
 * модуль» и вопрос «действует ли оплата» разные, и есть места (витрина, подсчёт
 * докупки), где нужен только первый. Все гейты доступа обязаны передавать срок —
 * без него подписка бессрочна.
 * @param {string[]|'all'|undefined} modules @param {string} moduleKey
 * @param {number|null} [expiresAt] срок подписки; null/не передан — бессрочно
 */
export function modulesAllow(modules, moduleKey, expiresAt) {
  if (subscriptionExpired(expiresAt)) return false
  if (modules === 'all' || modules == null) return true
  return Array.isArray(modules) && modules.includes(moduleKey)
}

/**
 * Как применить переданный набор к уже сохранённому (баг 19.08 §2).
 *
 * `'replace'` — набор становится ровно тем, что передали. Так админ ВЫДАЁТ доступы:
 * он говорит «у этого человека вот эти модули», и снять лишнее должно быть можно.
 *
 * `'merge'` — ДОКУПКА: к оплаченному добавляется новое. Клиентскому списку доверять
 * нельзя: кабинет присылал полный набор, и кнопка «Готовый набор» затирала им ранее
 * оплаченные модули — деньги списаны, доступ пропал. Теперь объединяет сервер.
 * @param {string[]|'all'|undefined} prev @param {string[]|'all'} list @param {'merge'|'replace'} mode
 */
function applyModules(prev, list, mode) {
  if (mode !== 'merge') return list
  if (prev === 'all' || list === 'all') return 'all'
  const cur = Array.isArray(prev) ? prev : []
  return [...new Set([...cur.map(String), ...(Array.isArray(list) ? list : [])])]
}

/**
 * Срок при докупке. Правило: докупка не укорачивает уже оплаченное.
 *  - записи ещё нет → новый срок как есть (это первая покупка);
 *  - было бессрочно → остаётся бессрочно;
 *  - период не указан (months=0) → старый срок не трогаем, иначе докупка молча
 *    сделала бы месячную подписку вечной;
 *  - иначе берём ДАЛЬНЮЮ дату: оплаченный год не должен схлопнуться до месяца
 *    из-за докупки одного модуля.
 */
/**
 * Какую дату окончания записать при ДОКУПКЕ (mode = 'merge').
 *
 * Подписка одна и с одной датой (решение владельца 21.08). Докупка модуля внутрь
 * действующей подписки дату НЕ двигает: иначе добавление парсера за $8 продлевало бы
 * весь набор за $121 — ровно это и происходило, пока здесь стоял `Math.max`.
 *
 * `explicit` — дата ПРОДЛЕНИЯ, посчитанная вызывающим от конца текущей подписки. Она
 * сильнее всего остального: продление за тем и приходит, чтобы дату сдвинуть.
 */
function mergeExpiry(prevExpiry, nextExpiry, hadRecord, explicit = null) {
  if (explicit) return explicit
  if (!hadRecord) return nextExpiry
  if (prevExpiry == null) return null
  if (nextExpiry == null) return prevExpiry
  return prevExpiry
}

/** Нормализованный режим записи набора. Умолчание — 'replace' (явная выдача). */
const modeOf = (opts) => (opts?.mode === 'merge' ? 'merge' : 'replace')

/**
 * Записать ОБЩИЙ набор пространства — то, что покупает владелец для всех.
 * @param {string[]|'all'} modules @param {string} [userId] чей баланс вернуть в ответе
 * @param {{months?:number, mode?:'merge'|'replace'}} [opts]
 */
export async function setModules(modules, userId, opts = {}) {
  const list = modules === 'all' ? 'all' : [...new Set((modules || []).map(String).filter(Boolean))]
  const expiresAt = subExpiry(opts)
  const mode = modeOf(opts)
  const db = sb()
  if (db) {
    const prev = mode === 'merge'
      ? (await db.from('subscriptions').select('modules, expires_at').eq('id', 'workspace').maybeSingle()).data
      : null
    const finalList = applyModules(prev?.modules, list, mode)
    const finalExpiry = mode === 'merge'
      ? mergeExpiry(prev?.expires_at ? ms(prev.expires_at) : null, expiresAt, !!prev, Number(opts?.expiresAt) || null)
      : expiresAt
    await db.from('subscriptions').upsert(
      { id: 'workspace', scope: 'workspace', user_id: null, modules: finalList, expires_at: iso(finalExpiry), updated_at: new Date().toISOString() },
      { onConflict: 'id' },
    )
    return getBalance(userId)
  }
  await mutateJson(BALANCE_FILE(), (all) => {
    const next = { ...(all || {}) }
    delete next.coins; delete next.planId; delete next.updatedAt
    const prev = next[SUBSCRIPTION_KEY]
    const hadRecord = !!prev && prev.modules !== undefined
    next[SUBSCRIPTION_KEY] = {
      modules: applyModules(prev?.modules, list, mode),
      expiresAt: mode === 'merge' ? mergeExpiry(prev?.expiresAt ?? null, expiresAt, hadRecord, Number(opts?.expiresAt) || null) : expiresAt,
      updatedAt: Date.now(),
    }
    return next
  })
  return getBalance(userId)
}

/**
 * Срок подписки: покупка на N месяцев → дата окончания. Демо без периода — null
 * («бессрочно», пока не подключён провайдер). 30 дней в месяце — витринное допущение.
 * @param {{months?:number}} opts
 */
const DAY = 24 * 60 * 60 * 1000
function subExpiry(opts = {}) {
  // Явная дата от вызывающего важнее месяцев: продление считается от КОНЦА действующей
  // подписки (см. /api/subscription), иначе продливший заранее терял оплаченный остаток.
  const explicit = Number(opts?.expiresAt) || 0
  if (explicit > 0) return explicit
  const months = Number(opts?.months) || 0
  return months > 0 ? Date.now() + Math.round(months * 30 * DAY) : null
}

/**
 * Личная покупка клиента: его набор перекрывает общий ТОЛЬКО для него.
 * Клиент заходит в «Мои модули», выбирает пакет — и видит ровно его; остальные
 * пользователи пространства не задеты.
 * @param {string[]|'all'} modules @param {string} userId
 * @param {{months?:number, mode?:'merge'|'replace'}} [opts] `merge` — докупка (§2, баг 19.08)
 */
export async function setUserModules(modules, userId, opts = {}) {
  if (!userId) throw new Error('Личная подписка требует пользователя')
  const list = modules === 'all' ? 'all' : [...new Set((modules || []).map(String).filter(Boolean))]
  const expiresAt = subExpiry(opts)
  const mode = modeOf(opts)
  const k = key(userId)
  const db = sb()
  if (db) {
    const prev = mode === 'merge'
      ? (await db.from('subscriptions').select('modules, expires_at').eq('id', k).maybeSingle()).data
      : null
    const finalList = applyModules(prev?.modules, list, mode)
    const finalExpiry = mode === 'merge'
      ? mergeExpiry(prev?.expires_at ? ms(prev.expires_at) : null, expiresAt, !!prev, Number(opts?.expiresAt) || null)
      : expiresAt
    await db.from('subscriptions').upsert(
      { id: k, scope: 'user', user_id: k, modules: finalList, expires_at: iso(finalExpiry), updated_at: new Date().toISOString() },
      { onConflict: 'id' },
    )
    return getBalance(userId)
  }
  await mutateJson(BALANCE_FILE(), (all) => {
    const next = { ...(all || {}) }
    delete next.coins; delete next.planId; delete next.updatedAt
    const prev = next[k]
    // Докупку мерджим по СВОЕЙ записи, а не по тому, что вернул бы getBalance:
    // там набор может быть унаследован от владельца пространства, и слив чужого
    // набора в личную запись выдал бы модули, за которые этот человек не платил.
    const hadRecord = !!prev && prev.modules !== undefined
    next[k] = {
      ...(prev || {}),
      modules: applyModules(prev?.modules, list, mode),
      expiresAt: mode === 'merge' ? mergeExpiry(prev?.expiresAt ?? null, expiresAt, hadRecord, Number(opts?.expiresAt) || null) : expiresAt,
      updatedAt: Date.now(),
    }
    return next
  })
  return getBalance(userId)
}

export const DEFAULT_STATE = { planId: 'basic', coins: 0, usd: 0, updatedAt: 0 }

/** §11.4: деньги считаем до центов — в отличие от токенов (тысячные доли действия). */
const normUsd = (v) => Math.round((Number(v) || 0) * 100) / 100

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
  const db = sb()
  if (db) {
    const k = key(userId)
    // §4.2 (MR-30): монеты/деньги — из кошелька владельца при общем балансе; подписка
    // (модули) остаётся по своему ключу.
    const wk = key(await resolveWalletOwner(userId))
    // §4.1 (MR-28): набор модулей суба — это набор ВЛАДЕЛЬЦА. Раньше здесь стоял свой
    // ключ, и суб без личной подписки проваливался на общий `workspace` — получая
    // модули, которых владелец не покупал.
    const sk = key(await resolveSubscriptionOwner(userId))
    const [coinRes, subRes, wsRes] = await Promise.all([
      db.from('coin_balance').select('coins, usd, updated_at').eq('user_id', wk).maybeSingle(),
      db.from('subscriptions').select('modules, expires_at').eq('id', sk).maybeSingle(),
      db.from('subscriptions').select('modules, expires_at').eq('id', 'workspace').maybeSingle(),
    ])
    const personal = subRes.data
    const ws = wsRes.data
    // Общий набор `workspace` — набор НАШЕГО пространства, а не подарок каждому.
    //
    // Правка 18.08. Раньше он был fallback'ом для любого, у кого нет своей записи, и
    // человек, только что зарегистрировавшийся с лендинга, получал 14 модулей бесплатно
    // (на проде так жили 56 из 65 юзеров). Теперь fallback работает только для
    // безсессионного дев-режима; у самостоятельного владельца без покупки набор ПУСТ.
    const modules = personal?.modules !== undefined && personal?.modules !== null
      ? personal.modules
      : (sk === DEFAULT_USER ? (ws?.modules ?? DEFAULT_MODULES) : [])
    const expiresAt = (personal ? personal.expires_at : ws?.expires_at) ? ms(personal ? personal.expires_at : ws.expires_at) : null
    const planId = DEFAULT_STATE.planId
    return {
      planId,
      plan: PLANS[planId],
      modules,
      expiresAt,
      // §11.4: два независимых остатка — деньги ($) и токены (coins).
      coins: normCoins(coinRes.data?.coins ?? 0),
      usd: normUsd(coinRes.data?.usd ?? 0),
      updatedAt: ms(coinRes.data?.updated_at),
    }
  }
  const all = await readJson(BALANCE_FILE(), {})
  // Старый формат — один кошелёк в корне файла. Читаем его как баланс `__default`,
  // чтобы уже начисленные монеты не пропали при переходе на пер-юзерное хранение.
  const legacy = typeof all?.coins === 'number' ? { coins: all.coins, planId: all.planId } : null
  const saved = (all && all[key(userId)]) || (key(userId) === DEFAULT_USER ? legacy : null) || {}
  const planId = PLANS[saved?.planId] ? saved.planId : DEFAULT_STATE.planId
  // §4.2 (MR-30): монеты/деньги — из кошелька владельца при общем балансе; модули/подписку
  // берём по своему ключу (saved). Ключи нормализуем через key() (undefined → __default).
  const ownKey = key(userId)
  const wk = key(await resolveWalletOwner(userId))
  // §4.1 (MR-28): подписку читаем у владельца пространства, а не у самого суба.
  const sk = key(await resolveSubscriptionOwner(userId))
  const subRec = sk === ownKey ? saved : ((all && all[sk]) || {})
  const walletRec = wk === ownKey ? saved : ((all && all[wk]) || (wk === DEFAULT_USER ? legacy : null) || {})
  return {
    planId,
    plan: PLANS[planId],
    // Набор модулей: СВОЙ (клиент купил лично) перекрывает общий на пространство.
    // Клиент, выбравший «парсер + комментинг за 20», видит свои два модуля, а
    // сотрудник без личной покупки работает внутри купленного владельцем. Срок
    // подписки (expiresAt) берём из того же источника, что и набор.
    // Общий набор пространства — только для безсессионного дев-режима (см. выше).
    modules: subRec?.modules !== undefined
      ? subRec.modules
      : (sk === DEFAULT_USER ? ((all && all[SUBSCRIPTION_KEY]?.modules) ?? DEFAULT_MODULES) : []),
    expiresAt: (subRec?.modules !== undefined
      ? subRec?.expiresAt
      : (sk === DEFAULT_USER ? (all && all[SUBSCRIPTION_KEY]?.expiresAt) : null)) ?? null,
    coins: normCoins(walletRec?.coins ?? DEFAULT_STATE.coins),
    usd: normUsd(walletRec?.usd ?? 0),
    updatedAt: Number(walletRec?.updatedAt) || 0,
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
  const db = sb()
  if (db) {
    const { data } = await db.from('coin_balance').select('user_id, coins')
    let coins = 0; let wallets = 0; let service = 0
    for (const r of data || []) {
      if (r.user_id === DEFAULT_USER) { service = Number(r.coins) || 0; continue }
      coins = Math.round((coins + (Number(r.coins) || 0)) * COIN_PRECISION) / COIN_PRECISION
      wallets += 1
    }
    return { coins, wallets, service }
  }
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
  const db = sb()
  if (db) {
    const { data } = await db.from('coin_balance').select('user_id, coins')
    const out = {}
    for (const r of data || []) {
      if (r.user_id === DEFAULT_USER) continue
      out[r.user_id] = Number(r.coins) || 0
    }
    return out
  }
  const all = await readJson(BALANCE_FILE(), {})
  const out = {}
  for (const [k, v] of Object.entries(all || {})) {
    if (k === SUBSCRIPTION_KEY || k === DEFAULT_USER) continue
    if (typeof v?.coins === 'number') out[k] = v.coins
  }
  return out
}

/**
 * §11.4: ДЕНЬГИ ($) по каждому кошельку — id пользователя → сколько долларов сейчас.
 *
 * Зеркало coinsByUser для денежного остатка: со звонка 29.07 «$ — основное», и в
 * админке «На счету» должно показываться прежде токенов. Служебные кошельки не отдаём.
 * @returns {Promise<Record<string, number>>}
 */
export async function usdByUser() {
  const db = sb()
  if (db) {
    const { data } = await db.from('coin_balance').select('user_id, usd')
    const out = {}
    for (const r of data || []) {
      if (r.user_id === DEFAULT_USER) continue
      out[r.user_id] = normUsd(r.usd ?? 0)
    }
    return out
  }
  const all = await readJson(BALANCE_FILE(), {})
  const out = {}
  for (const [k, v] of Object.entries(all || {})) {
    if (k === SUBSCRIPTION_KEY || k === DEFAULT_USER) continue
    if (typeof v?.usd === 'number') out[k] = normUsd(v.usd)
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
  const k = key(await resolveWalletOwner(userId)) // §4.2 (MR-30): общий баланс → кошелёк владельца
  let result = null
  const db = sb()
  if (db) {
    // Read-modify-write. Для демо-нагрузки достаточно; продакшн-шаг — атомарная
    // Postgres-функция (rpc), чтобы параллельные списания не гонялись.
    const { data: cur } = await db.from('coin_balance').select('coins').eq('user_id', k).maybeSingle()
    const before = normCoins(cur?.coins ?? 0)
    const after = normCoins(before + delta)
    await db.from('coin_balance').upsert({ user_id: k, coins: after, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    result = { before, after, applied: Math.round((after - before) * COIN_PRECISION) / COIN_PRECISION, reason, userId: k }
    if (result.applied) await appendWalletEntry(result).catch(() => {})
    return result
  }
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
  const db = sb()
  if (db) {
    // §11.4: currency — 'usd' для денег, 'coins' для токенов. Колонка появляется
    // миграцией 2026-07-31-wallet-currency.sql; пока её нет — пишем без валюты
    // (запись не должна ломаться из-за неприменённой миграции).
    const base = {
      ts: new Date().toISOString(), user_id: entry.userId, amount: entry.applied,
      before_val: entry.before, after_val: entry.after, reason: String(entry.reason || ''),
    }
    const currency = entry.currency === 'usd' ? 'usd' : 'coins'
    const { error } = await db.from('wallet_log').insert({ ...base, currency })
    if (error && /currency/i.test(error.message)) await db.from('wallet_log').insert(base)
    return
  }
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
    currency: entry.currency === 'usd' ? 'usd' : 'coins',
  }
  await fs.appendFile(file, JSON.stringify(row) + '\n', 'utf8')
}

/**
 * Операции по кошельку: свежие сверху. Без userId — по всем (для админки).
 * @param {{userId?:string, limit?:number, since?:number}} [filter]
 */
export async function walletHistory(filter = {}) {
  const limitN = Math.min(1000, Math.max(1, Number(filter.limit) || 100))
  const db = sb()
  if (db) {
    // §11.4: тянем и currency. Колонка появляется миграцией 2026-07-31 — если её ещё
    // нет, PostgREST вернёт ошибку на весь select, поэтому при промахе повторяем без неё.
    const build = (cols) => {
      let q = db.from('wallet_log').select(cols).order('ts', { ascending: false }).limit(limitN)
      if (filter.userId) q = q.eq('user_id', key(filter.userId))
      if (filter.since) q = q.gte('ts', new Date(Number(filter.since)).toISOString())
      return q
    }
    let { data, error } = await build('ts, user_id, amount, before_val, after_val, reason, currency')
    if (error && /currency/i.test(error.message || '')) ({ data } = await build('ts, user_id, amount, before_val, after_val, reason'))
    return (data || []).map((r) => ({
      ts: ms(r.ts), userId: r.user_id, amount: Number(r.amount),
      before: r.before_val == null ? null : Number(r.before_val),
      after: r.after_val == null ? null : Number(r.after_val), reason: r.reason || '',
      currency: r.currency === 'usd' ? 'usd' : 'coins',
    }))
  }
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
  // В Supabase тариф не храним отдельно (он легаси и фиксирован: getBalance всегда
  // отдаёт 'basic'). Модель перешла на наборы модулей — plan-колонки в схеме нет.
  if (sb()) return getBalance(userId)
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

/**
 * §11.4: изменить ДЕНЕЖНЫЙ баланс ($). Зеркало changeCoins, но для денег.
 *
 * Разделение со звонка 30.07: «$ — основное, за них покупаем подписки и токены».
 * Поэтому пополнение платёжной системой и оплата подписки идут сюда, а расход
 * модулей — по-прежнему в токены (changeCoins).
 *
 * @param {number} amount дельта в долларах (может быть отрицательной)
 * @param {string} reason за что — попадает в журнал кошелька
 */
export async function changeUsd(amount, reason = '', userId) {
  const delta = Math.round((Number(amount) || 0) * 100) / 100
  const k = key(await resolveWalletOwner(userId)) // §4.2 (MR-30): общий баланс → кошелёк владельца
  const db = sb()
  if (db) {
    const { data: cur } = await db.from('coin_balance').select('usd').eq('user_id', k).maybeSingle()
    const before = normUsd(cur?.usd ?? 0)
    const after = normUsd(before + delta)
    const { error } = await db.from('coin_balance').upsert(
      { user_id: k, usd: after, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    // Колонка появляется миграцией 2026-07-30-usd-wallet.sql. Пока её нет — честно
    // говорим об этом, а не делаем вид, что деньги зачислены.
    if (error) throw new Error(/usd/i.test(error.message) ? 'Денежный баланс недоступен: примените миграцию 2026-07-30-usd-wallet.sql' : error.message)
    const result = { before, after, applied: Math.round((after - before) * 100) / 100, reason, userId: k, currency: 'usd' }
    if (result.applied) await appendWalletEntry(result).catch(() => {})
    return result
  }
  let result = null
  await mutateJson(BALANCE_FILE(), (all) => {
    const cur = (all && all[k]) || {}
    const before = normUsd(cur?.usd ?? 0)
    const after = normUsd(before + delta)
    result = { before, after, applied: Math.round((after - before) * 100) / 100, reason, userId: k, currency: 'usd' }
    const next = { ...(all || {}) }
    next[k] = { ...cur, usd: after, updatedAt: Date.now() }
    return next
  }, {})
  if (result?.applied) await appendWalletEntry(result).catch(() => {})
  return result
}

/**
 * §11.4: купить токены за деньги — «$ ↓, токены ↑», как описал владелец.
 *
 * Курс берём из пакетов пополнения (тот же, что показывает витрина), чтобы цена
 * покупки и цена на сайте не разъезжались. Списываем деньги ПЕРВЫМИ: если на этом
 * шаге не хватило — токены не начисляем. Обратный порядок мог бы выдать токены
 * бесплатно при сбое между двумя записями.
 *
 * @param {{usd:number, userId?:string}} input сколько долларов потратить
 */
export async function buyTokens({ usd, userId } = {}) {
  const spend = Math.round((Number(usd) || 0) * 100) / 100
  if (!(spend > 0)) throw new Error('Укажите сумму больше нуля')

  const { coinUsdRate } = await import('./priceStore.js')
  const rate = await coinUsdRate() // $ за один токен
  if (!(rate > 0)) throw new Error('Не задан курс токена — заполните пакеты пополнения в админке')

  const bal = await getBalance(userId)
  if ((bal.usd ?? 0) < spend) throw new Error(`Недостаточно средств: на счету $${(bal.usd ?? 0).toFixed(2)}`)

  const tokens = Math.round((spend / rate) * COIN_PRECISION) / COIN_PRECISION
  await changeUsd(-spend, `Покупка токенов: ${tokens} ⚡`, userId)
  try {
    await changeCoins(tokens, `Куплено за $${spend.toFixed(2)}`, userId)
  } catch (e) {
    // Деньги уже списаны — возвращаем их, иначе клиент теряет средства молча.
    await changeUsd(spend, 'Возврат: не удалось начислить токены', userId).catch(() => {})
    throw e
  }
  return { spentUsd: spend, tokens, rate, balance: await getBalance(userId) }
}
