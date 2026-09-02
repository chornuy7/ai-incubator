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
import { readModuleLinks } from './lib/moduleIds.js'

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
 * Состав подписки хранится СТРОКАМИ в `user_subscriptions` (созвон 19.08: «никакого
 * джейсона в базе данных»; JSON-массив в subscriptions.modules заказчик назвал
 * «огромной дыркой»). Здесь — чтение и запись этих строк.
 *
 * Переносим только ХРАНЕНИЕ, поведение остаётся прежним:
 *  - дата ОДНА на всю подписку: во всех строках пользователя она одинаковая, потому что
 *    пишем её всем разом. Строка на модуль — способ хранения, а не помодульный срок;
 *  - читаем ПОЛНЫЙ состав, включая истёкший: иначе просрочка выглядит как «ничего не
 *    куплено» и продлевать в кабинете нечего;
 *  - объединение набора остаётся выше по коду (applyModules) — сюда приходит уже
 *    итоговый список.
 */
/*
 * Строка-метка «все модули» — УСТАРЕВШИЙ способ записи (MR-290).
 *
 * Строка user_subscriptions означает «у владельца есть модуль X». Строка со звёздочкой
 * означала «есть все модули, включая будущие» — то есть свойство самой подписки,
 * записанное в поле для имени модуля. Из-за неё на module_key нельзя было поставить
 * внешний ключ на справочник модулей, а три места в коде вручную помнили про исключение.
 *
 * Теперь признак живёт в `subscriptions.all_modules`. Метка ещё читается: миграции
 * применяются раньше выката кода, и в этом окне на сервере работает предыдущая версия,
 * которая её пишет. Писать её мы уже перестали; оставшиеся строки уберёт отдельная
 * миграция следующим релизом — вместе с внешним ключом на справочник.
 */
const ALL_ROW = '*'

/**
 * Строки → состав подписки. Вынесено отдельно и без базы, потому что здесь три правила,
 * которые уже терялись при слияниях: признак «все модули», ОДНА дата на подписку и полный
 * состав вместе с истёкшим.
 * @param {{module_key:string, expires_at:string|number|null}[]} rows
 * @param {boolean} [allModules] флаг подписки; строка-метка в rows — запасной путь
 * @returns {{modules:'all'|string[], expiresAt:number|null}}
 */
export function rowsToModules(rows = [], allModules = false) {
  // Дата одна на всю подписку; берём максимум — на случай, если строки разъехались.
  const expiresAt = rows.reduce((acc, r) => {
    const t = r?.expires_at ? ms(r.expires_at) : null
    return t && (!acc || t > acc) ? t : acc
  }, null)
  // Истёкшие строки НЕ отбрасываем: просрочка должна выглядеть как «истекла, продлите»,
  // а не «ничего не куплено» — иначе в кабинете нечего продлевать.
  if (allModules || rows.some((r) => r?.module_key === ALL_ROW)) return { modules: 'all', expiresAt }
  return { modules: rows.map((r) => r?.module_key).filter((k) => k && k !== ALL_ROW), expiresAt }
}

/**
 * Прочитать состав. `null` — сказать нечего: ни строк, ни признака «все модули».
 *
 * Признак читается ОТДЕЛЬНЫМ запросом к подписке, а не выводится из строк: у подписки
 * «всё включено» своих строк состава не бывает вовсе, и по их отсутствию её не отличить
 * от подписки, которой нет.
 */
async function readModuleRows(db, id) {
  const [rowsRes, subRes] = await Promise.all([
    db.from('user_subscriptions').select('module_key, expires_at, updated_at').eq('user_id', id),
    db.from('subscriptions').select('all_modules').eq('id', id).maybeSingle(),
  ])
  if (rowsRes.error) return null
  // Колонки ещё нет (код уехал вперёд миграций) — работаем по строке-метке, как раньше.
  const allModules = subRes.error ? false : subRes.data?.all_modules === true
  const data = rowsRes.data || []
  if (!allModules && !data.length) return null
  const touchedAt = data.reduce((acc, r) => Math.max(acc, r?.updated_at ? ms(r.updated_at) : 0), 0)
  return { ...rowsToModules(data, allModules), touchedAt }
}

/** Записать ИТОГОВЫЙ состав: признак — на подписку, модули — строками. */
async function writeModuleRows(db, id, list, expiresAt) {
  const all = list === 'all'
  const nowIso = new Date().toISOString()
  const expIso = iso(expiresAt)

  /*
   * Сначала признак — и обязательно с проверкой, что он КУДА-ТО записался.
   *
   * Две причины, по которым записать его может быть некуда: колонки ещё нет (код уехал
   * вперёд миграций) или строки подписки ещё нет (её заводят выше по коду, и порядок
   * когда-нибудь поменяют). В обоих случаях возвращаемся к старому способу и оставляем
   * метку строкой. Иначе вышло бы худшее из возможного: метку стёрли, флаг записать
   * некуда — и подписка «всё включено» молча превратилась бы в пустую.
   *
   * `.select('id')` здесь не для данных: без него update по несуществующей строке
   * проходит без ошибки, и отличить «записал» от «не нашёл кого» было бы нечем.
   */
  const flagRes = await db.from('subscriptions').update({ all_modules: all }).eq('id', id).select('id')
  const flagSaved = !flagRes.error && (flagRes.data || []).length > 0
  const want = all
    ? (flagSaved ? [] : [ALL_ROW])
    : [...new Set((list || []).map(String).filter(Boolean))]

  const { data: have } = await db.from('user_subscriptions').select('module_key').eq('user_id', id)
  const gone = (have || []).map((r) => r.module_key).filter((k) => !want.includes(k))
  if (want.length) {
    // Дату обновляем у ВСЕХ строк: продление двигает срок всей подписке, докупка
    // приходит с той же (неизменной) датой — поэтому остальным модулям она не сдвинется.
    await db.from('user_subscriptions').upsert(
      want.map((module_key) => ({ user_id: id, module_key, expires_at: expIso, updated_at: nowIso })),
      { onConflict: 'user_id,module_key' },
    )
  }
  if (gone.length) await db.from('user_subscriptions').delete().eq('user_id', id).in('module_key', gone)
}

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
    // Предыдущий состав — из СТРОК, а не из JSON-колонки: объединение набора (контракт,
    // п.2) должно опираться на то же хранилище, из которого потом читают. Срок берём со
    // строк, а если их нет — с самой подписки: там он и живёт вместе с днём начисления.
    const prevRows = mode === 'merge' ? await readModuleRows(db, 'workspace').catch(() => null) : null
    const prevSub = mode === 'merge'
      ? (await db.from('subscriptions').select('expires_at').eq('id', 'workspace').maybeSingle()).data
      : null
    const prevExpiry = prevRows?.expiresAt ?? (prevSub?.expires_at ? ms(prevSub.expires_at) : null)
    const finalList = applyModules(prevRows?.modules, list, mode)
    const finalExpiry = mode === 'merge'
      ? mergeExpiry(prevExpiry, expiresAt, !!(prevRows || prevSub), Number(opts?.expiresAt) || null)
      : expiresAt
    await db.from('subscriptions').upsert(
      // `modules` не пишем: состав хранится строками в user_subscriptions.
      { id: 'workspace', scope: 'workspace', user_id: null, expires_at: iso(finalExpiry), updated_at: new Date().toISOString() },
      { onConflict: 'id' },
    )
    // Состав — строками. Старую колонку пока пишем тоже: живые деньги, и откат должен
    // быть возможен без потери данных. Читаем уже из строк (см. getBalance).
    await writeModuleRows(db, 'workspace', finalList, finalExpiry).catch((e) => {
      console.warn('[subscriptions] строки состава не записаны:', e?.message)
    })
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
    // Предыдущий состав — из СТРОК, а не из JSON-колонки: объединение набора (контракт,
    // п.2) должно опираться на то же хранилище, из которого потом читают. Срок берём со
    // строк, а если их нет — с самой подписки: там он и живёт вместе с днём начисления.
    const prevRows = mode === 'merge' ? await readModuleRows(db, k).catch(() => null) : null
    const prevSub = mode === 'merge'
      ? (await db.from('subscriptions').select('expires_at').eq('id', k).maybeSingle()).data
      : null
    const prevExpiry = prevRows?.expiresAt ?? (prevSub?.expires_at ? ms(prevSub.expires_at) : null)
    const finalList = applyModules(prevRows?.modules, list, mode)
    const finalExpiry = mode === 'merge'
      ? mergeExpiry(prevExpiry, expiresAt, !!(prevRows || prevSub), Number(opts?.expiresAt) || null)
      : expiresAt
    await db.from('subscriptions').upsert(
      // `modules` не пишем: состав хранится строками в user_subscriptions.
      { id: k, scope: 'user', user_id: k, expires_at: iso(finalExpiry), updated_at: new Date().toISOString() },
      { onConflict: 'id' },
    )
    await writeModuleRows(db, k, finalList, finalExpiry).catch((e) => {
      console.warn('[subscriptions] строки состава не записаны:', e?.message)
    })
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
/**
 * Состав подписки для многих пользователей разом.
 *
 * @param {string[]} userIds
 * @returns {Promise<Map<string, string[]|'all'>>} id пользователя → модули
 */
export async function modulesForUsers(userIds = []) {
  const ids = [...new Set(userIds.map((x) => String(x || '')).filter(Boolean))]
  const out = new Map()
  if (!ids.length) return out
  const db = sb()
  if (!db) {
    // Файловый режим: данных мало, честный поштучный обход дешевле лишнего кода.
    for (const id of ids) out.set(id, (await getBalance(id)).modules)
    return out
  }

  // 1. Карта профилей — ОДИН раз на всю операцию.
  const { data: profiles } = await db.from('profiles').select('id, legacy_id, parent_id')
  const строки = (profiles || []).filter((p) => p.legacy_id)
  const legacyByUuid = new Map(строки.map((p) => [p.id, p.legacy_id]))
  const родитель = new Map(строки.map((p) => [p.legacy_id, p.parent_id ? (legacyByUuid.get(p.parent_id) || null) : null]))
  const владелец = (id) => {
    let cur = id
    const seen = new Set()
    while (родитель.get(cur) && !seen.has(cur)) { seen.add(cur); cur = родитель.get(cur) }
    return cur
  }
  const ключи = new Map(ids.map((id) => [id, key(владелец(id))]))
  const владельцы = [...new Set([...ключи.values(), 'workspace'])]

  // 2. Строки состава и признак «все модули» — по одному запросу на всех владельцев.
  const [rowsRes, subRes] = await Promise.all([
    db.from('user_subscriptions').select('user_id, module_key, expires_at').in('user_id', владельцы),
    db.from('subscriptions').select('id, all_modules').in('id', владельцы),
  ])
  const поВладельцу = new Map()
  for (const r of rowsRes.data || []) {
    if (!поВладельцу.has(r.user_id)) поВладельцу.set(r.user_id, [])
    поВладельцу.get(r.user_id).push(r)
  }
  const всеМодули = new Map((subRes.data || []).map((r) => [r.id, r.all_modules === true]))

  for (const [id, k] of ключи) {
    const rows = поВладельцу.get(k) || []
    const all = всеМодули.get(k) === true
    // Та же развилка, что в getBalance: своей подписки нет — общий набор пространства
    // достаётся только дев-режиму, остальным пусто.
    if (!all && !rows.length) { out.set(id, k === DEFAULT_USER ? (rowsToModules(поВладельцу.get('workspace') || [], всеМодули.get('workspace') === true).modules ?? DEFAULT_MODULES) : []); continue }
    out.set(id, rowsToModules(rows, all).modules)
  }
  return out
}

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
    const [coinRes, subRes, wsRes, subRows, wsRows] = await Promise.all([
      db.from('coin_balance').select('coins, usd, updated_at').eq('user_id', wk).maybeSingle(),
      // `modules` из этой таблицы больше НЕ читаем — состав живёт строками.
      db.from('subscriptions').select('expires_at').eq('id', sk).maybeSingle(),
      db.from('subscriptions').select('expires_at').eq('id', 'workspace').maybeSingle(),
      readModuleRows(db, sk).catch(() => null),
      readModuleRows(db, 'workspace').catch(() => null),
    ])
    /*
     * Состав подписки — ТОЛЬКО строки `user_subscriptions` (созвон 19.08: «никакого
     * джейсона в базе данных»). Переходный период закончился: строки есть у всех
     * подписок, JSON-колонка `subscriptions.modules` больше не пишется и не читается.
     *
     * Срок берём с самой подписки, если строк нет вовсе: она хранит дату, день начисления
     * и отметку месяца — это свойства подписки, а не модуля.
     */
    const shape = (rows, row) => (rows
      ? { modules: rows.modules, expires_at: rows.expiresAt ? iso(rows.expiresAt) : (row?.expires_at ?? null) }
      : (row ? { modules: undefined, expires_at: row.expires_at } : null))
    const personal = shape(subRows, subRes.data)
    const ws = shape(wsRows, wsRes.data)
    // Общий набор `workspace` — набор НАШЕГО пространства, а не подарок каждому.
    //
    // Правка 18.08. Раньше он был fallback'ом для любого, у кого нет своей записи, и
    // человек, только что зарегистрировавшийся с лендинга, получал 14 модулей бесплатно
    // (на проде так жили 56 из 65 юзеров). Теперь fallback работает только для
    // безсессионного дев-режима; у самостоятельного владельца без покупки набор ПУСТ.
    const usePersonal = personal?.modules !== undefined && personal?.modules !== null
    const modules = usePersonal
      ? personal.modules
      : (sk === DEFAULT_USER ? (ws?.modules ?? DEFAULT_MODULES) : [])
    // Срок берём из ТОГО ЖЕ источника, что и набор. Правка 18.08 закрыла наследование
    // модулей от `workspace`, но дату оставила падать на него безусловно — и человек
    // без своей подписки «наследовал» чужой срок. Последствия на проде: первая покупка
    // уходила в ветку ДОКУПКИ (срок-то «активен») — списывалось только за остаток чужих
    // дней ($24 вместо $30 за месяц), а своей даты окончания у клиента так и не
    // появлялось, потому что докупка дату не двигает.
    const subSrc = usePersonal ? personal : (sk === DEFAULT_USER ? ws : null)
    const expiresAt = subSrc?.expires_at ? ms(subSrc.expires_at) : null
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
/**
 * @param {'purchase'|'grant'} [kind] чем является начисление: покупкой за деньги или
 * выдачей (подарок, месячные токены подписки, ручное начисление админом). Влияет на
 * ОТЧЁТЫ, а не на баланс: §3.2 — доходом является покупка плана, а не выданные токены.
 */
export async function changeCoins(amount, reason = '', userId, kind, modules) {
  const delta = Math.round((Number(amount) || 0) * COIN_PRECISION) / COIN_PRECISION
  const k = key(await resolveWalletOwner(userId)) // §4.2 (MR-30): общий баланс → кошелёк владельца
  /*
   * КТО потратил — отдельно от того, ЧЕЙ кошелёк (правка 27.08).
   *
   * При общем балансе списание сотрудника уходит в кошелёк владельца, и в журнал до сих
   * пор писался только владелец: исходный userId затирался строкой выше. Из-за этого на
   * вопрос «кто сколько потратил» ответить было нечем — все операции выглядели как траты
   * одного человека. Владелец 27.08: «овнер должен видеть, кто сколько потратил».
   */
  const actor = key(userId)
  let result = null
  const db = sb()
  if (db) {
    // Read-modify-write. Для демо-нагрузки достаточно; продакшн-шаг — атомарная
    // Postgres-функция (rpc), чтобы параллельные списания не гонялись.
    const { data: cur } = await db.from('coin_balance').select('coins').eq('user_id', k).maybeSingle()
    const before = normCoins(cur?.coins ?? 0)
    const after = normCoins(before + delta)
    await db.from('coin_balance').upsert({ user_id: k, coins: after, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    result = { before, after, applied: Math.round((after - before) * COIN_PRECISION) / COIN_PRECISION, reason, userId: k, actorId: actor, kind, modules }
    if (result.applied) await appendWalletEntry(result).catch(() => {})
    return result
  }
  await mutateJson(BALANCE_FILE(), (all) => {
    const cur = (all && all[k]) || (k === DEFAULT_USER && typeof all?.coins === 'number' ? { coins: all.coins, planId: all.planId } : {})
    const before = normCoins(cur?.coins ?? DEFAULT_STATE.coins)
    const after = normCoins(before + delta)
    result = { before, after, applied: Math.round((after - before) * COIN_PRECISION) / COIN_PRECISION, reason, userId: k, actorId: actor, kind, modules }
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

/** Состав подписки для строк журнала: id записи → ключи модулей по порядку. */
const modulesByLogEntry = (db, ids) => readModuleLinks(db, 'wallet_log_modules', 'log_id', ids)

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
    // actor_id появляется миграцией 2026-08-27-wallet-actor.sql. Пока её нет — пишем без
    // него: потерять строку журнала из-за неприменённой миграции хуже, чем потерять поле.
    const withActor = entry.actorId && entry.actorId !== entry.userId ? { ...base, actor_id: entry.actorId } : base
    const currency = entry.currency === 'usd' ? 'usd' : 'coins'
    // §3.2 (MR-22): чем начисление ЯВЛЯЕТСЯ — покупкой или выдачей. Подарочные и
    // месячные токены подписки доходом не считаются («доходом является покупка плана»),
    // поэтому природу операции фиксируем в момент записи, а не угадываем по тексту
    // причины. Колонка добавляется миграцией 2026-08-22-wallet-kind.sql.
    const kind = entry.kind || null
    // MR-230: состав подписки — колонкой, а не разбором текста причины. Названия модулей
    // содержат и запятые, и тире («AIR — AI Rating»), так что любой разделитель однажды
    // окажется внутри названия. Миграция 2026-08-31-wallet-modules.sql.
    const modules = Array.isArray(entry.modules) && entry.modules.length ? entry.modules.map(String) : null

    /*
     * Необязательные колонки появляются миграциями, и запись НЕ должна ломаться, пока
     * миграция не применена: потерянная строка журнала досаднее потерянного поля.
     *
     * Раньше здесь была лесенка вложенных if — по ветке на колонку. С четвёртой она
     * перестала читаться, а порядок отката в ней уже разъезжался. Теперь одно правило:
     * база пожаловалась на колонку — выбрасываем её и пробуем снова, пока не останется
     * тот минимум, который есть в схеме с самого начала.
     */
    const строка = { ...withActor, currency, kind, modules }

    /*
     * MR-290: строка журнала и состав подписки уезжают ОДНИМ вызовом (миграция
     * 2026-09-02-mr290-arrays-to-links.sql). Через PostgREST это два запроса, и между
     * ними процесс может умереть — в базе остаётся списание без основания. Для денег
     * половинчатая запись хуже, чем отказ: сумма есть, объяснения нет.
     *
     * Функции ещё нет (миграция не доехала) — ниже прежний путь, он рабочий.
     */
    const { error: rpcErr } = await db.rpc('wallet_log_append', { entry: строка, module_keys: modules })
    if (!rpcErr) return
    if (!/function|schema cache|does not exist/i.test(rpcErr.message || '')) {
      // Функция есть и отказала по существу — например, состав ссылается на модуль,
      // которого нет в справочнике. Повторять то же самое обычной вставкой значило бы
      // обойти проверку, ради которой всё и делалось.
      // Вызывающий глушит ошибки журнала намеренно («потерянная строка досадна,
      // потерянное списание — деньги»), поэтому отказ ещё и печатаем: иначе он
      // растворится совсем.
      console.warn('[wallet_log] запись журнала отклонена:', rpcErr.message)
      throw new Error(`[wallet_log] запись журнала отклонена: ${rpcErr.message}`)
    }

    for (const колонка of ['modules', 'actor_id', 'kind', 'currency']) {
      const { error } = await db.from('wallet_log').insert(строка)
      if (!error) return
      if (!new RegExp(колонка, 'i').test(error.message)) break
      delete строка[колонка]
    }
    await db.from('wallet_log').insert(base)
    return
  }
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const file = WALLET_LOG()
  await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {})
  const row = {
    ts: Date.now(),
    userId: entry.userId,
    // Кто именно потратил: при общем балансе это сотрудник, а userId выше — владелец
    // кошелька. Пишем только когда отличается, чтобы не раздувать старый формат.
    ...(entry.actorId && entry.actorId !== entry.userId ? { actorId: entry.actorId } : {}),
    amount: entry.applied,
    before: entry.before,
    after: entry.after,
    reason: String(entry.reason || ''),
    currency: entry.currency === 'usd' ? 'usd' : 'coins',
    // Состав — только когда есть: старый формат строк не раздуваем пустым полем.
    ...(Array.isArray(entry.modules) && entry.modules.length ? { modules: entry.modules.map(String) } : {}),
  }
  await fs.appendFile(file, JSON.stringify(row) + '\n', 'utf8')
}

/**
 * Операции по кошельку: свежие сверху. Без userId — по всем (для админки).
 * @param {{userId?:string, limit?:number, since?:number}} [filter]
 */
export async function walletHistory(filter = {}) {
  const limitN = Math.min(1000, Math.max(1, Number(filter.limit) || 100))
  /*
   * История читается по ТОМУ ЖЕ кошельку, что и баланс.
   *
   * Записи в журнал идут под владельцем кошелька (`changeCoins`/`changeUsd` зовут
   * `resolveWalletOwner`), а история фильтровалась по СВОЕМУ id. Для сотрудника с общим
   * балансом это значило: в шапке деньги владельца, они на глазах тратятся, а в «Истории
   * операций» пусто — «купил подписки, тратил деньги, выдал баланс, нету ничего»
   * (владелец, 21.08). Своего кошелька у такого сотрудника нет, поэтому и истории у него
   * своей быть не может — она общая, как и деньги.
   *
   * У сотрудника с ЛИЧНЫМ балансом resolveWalletOwner вернёт его самого — он увидит
   * только свои операции, как и раньше.
   */
  /*
   * `exact` — читать журнал СТРОГО этого пользователя, без подъёма к владельцу кошелька.
   *
   * Нужен там, где вопрос именно про сотрудника: «сколько ему выдано». Обычный режим
   * поднимается к владельцу (у сотрудника на общем балансе своей истории нет — она общая,
   * как и деньги), и на этом подъёме «выдано сотруднику» превращалось в «все начисления
   * владельца»: у владельца лежали 200 токенов подписки, и витрина показывала их как
   * выданные сотруднику, которому не выдавали ничего (баг 31.08).
   */
  const owner = filter.userId ? (filter.exact ? filter.userId : await resolveWalletOwner(filter.userId)) : null
  const db = sb()
  if (db) {
    // §11.4: тянем и currency. Колонка появляется миграцией 2026-07-31 — если её ещё
    // нет, PostgREST вернёт ошибку на весь select, поэтому при промахе повторяем без неё.
    const build = (cols) => {
      let q = db.from('wallet_log').select(cols).order('ts', { ascending: false }).limit(limitN)
      if (owner) q = q.eq('user_id', key(owner))
      if (filter.since) q = q.gte('ts', new Date(Number(filter.since)).toISOString())
      return q
    }
    // Состав подписки (миграция 2026-08-31) — им интерфейс разворачивает «и ещё 11».
    // id тянем всегда: по нему подбирается состав подписки из таблицы связей.
    let { data, error } = await build('id, ts, user_id, actor_id, amount, before_val, after_val, reason, currency, modules')
    if (error && /modules/i.test(error.message || '')) ({ data, error } = await build('id, ts, user_id, actor_id, amount, before_val, after_val, reason, currency'))
    // Колонки актора может ещё не быть (миграция 2026-08-27) — тогда читаем без неё.
    if (error && /actor_id/i.test(error.message || '')) ({ data, error } = await build('id, ts, user_id, amount, before_val, after_val, reason, currency'))
    if (error && /currency/i.test(error.message || '')) ({ data } = await build('id, ts, user_id, amount, before_val, after_val, reason'))
    // MR-290: состав подписки — из wallet_log_modules; колонка modules остаётся
    // запасным путём на окно между накаткой миграции и выкатом кода.
    const составы = await modulesByLogEntry(db, (data || []).map((r) => r.id).filter((v) => v != null))
    return (data || []).map((r) => {
      const modules = составы?.get(String(r.id)) ?? (Array.isArray(r.modules) ? r.modules : [])
      return {
        ts: ms(r.ts), userId: r.user_id, actorId: r.actor_id || r.user_id, amount: Number(r.amount),
        before: r.before_val == null ? null : Number(r.before_val),
        after: r.after_val == null ? null : Number(r.after_val), reason: r.reason || '',
        currency: r.currency === 'usd' ? 'usd' : 'coins',
        ...(modules.length ? { modules } : {}),
      }
    })
  }
  const fs = await import('node:fs/promises')
  let raw = ''
  try { raw = await fs.readFile(WALLET_LOG(), 'utf8') } catch { return [] }
  const limit = Math.min(1000, Math.max(1, Number(filter.limit) || 100))
  const since = Number(filter.since) || 0
  const wanted = owner ? key(owner) : null

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

/**
 * Кто сколько потратил из кошелька (просьба владельца 27.08: «овнер должен видеть, кто
 * сколько потратил»).
 *
 * Считаем только СПИСАНИЯ (amount < 0): начисления — это пополнение кошелька, а не расход
 * сотрудника, и складывать их вместе значило бы показывать владельцу, что он «потратил»
 * собственную выдачу. Запись без актора — трата самого владельца кошелька: так выглядят
 * все операции до 27.08, и сваливать их на сотрудников нельзя.
 *
 * @param {{userId: string, since?: number, limit?: number}} filter
 * @returns {Promise<{actorId: string, spent: number, ops: number}[]>} по убыванию расхода
 */
export async function spendByActor(filter = {}) {
  const rows = await walletHistory({ userId: filter.userId, since: filter.since, limit: filter.limit || 1000 })
  const byActor = new Map()
  for (const r of rows) {
    if (r.currency === 'usd') continue // доллары — отдельная валюта, в расход монет не мешаем
    const amount = Number(r.amount) || 0
    if (amount >= 0) continue
    const who = String(r.actorId || r.userId || '')
    const cur = byActor.get(who) || { actorId: who, spent: 0, ops: 0 }
    cur.spent = Math.round((cur.spent + Math.abs(amount)) * COIN_PRECISION) / COIN_PRECISION
    cur.ops += 1
    byActor.set(who, cur)
  }
  return [...byActor.values()].sort((a, b) => b.spent - a.spent)
}

/**
 * Лимит расхода сотрудника (решение владельца 27.08: «он должен унаследовать всё, что у
 * владельца, просто лимит по токенам, которые ему дали, добавляется ограничение»).
 *
 * Кошелёк один — владельца, и сотрудник наследует и его, и подписку. Лимит не отделяет
 * деньги, а ограничивает, СКОЛЬКО из общего кошелька этот сотрудник вправе потратить.
 * Потраченное считаем по журналу: с 27.08 в каждой операции записан её автор.
 *
 * Лимит накопительный, а не за период: «выдали 500» значит «всего 500». Поднять — это
 * выдать ещё, опустить — забрать неизрасходованное. Так цифра в карточке отвечает на
 * вопрос владельца «сколько я ему дал», а не «сколько он тратит в месяц».
 *
 * @param {string} userId @returns {Promise<{limit:number|null, spent:number, left:number}>}
 *   limit === null — ограничения нет (сотрудник тратит наравне с владельцем).
 */
export async function spendLimit(userId) {
  const id = String(userId || '')
  if (!id) return { limit: null, spent: 0, left: Infinity }
  const { getUser } = await import('./users.js')
  const user = await getUser(id).catch(() => null)
  const limit = user && user.tokenLimit != null ? Math.max(0, Number(user.tokenLimit) || 0) : null
  if (limit === null) return { limit: null, spent: 0, left: Infinity }
  // Владельцу кошелька лимит не ставим: ограничивать себя в своих же деньгах бессмысленно.
  const walletOwner = await resolveWalletOwner(id)
  if (walletOwner === id) return { limit: null, spent: 0, left: Infinity }
  const rows = await spendByActor({ userId: walletOwner, limit: 1000 })
  const mine = rows.find((r) => r.actorId === id)
  const spent = mine ? mine.spent : 0
  return { limit, spent, left: Math.round((limit - spent) * COIN_PRECISION) / COIN_PRECISION }
}

/**
 * Перевод токенов между владельцем и его сотрудником (MR-225).
 *
 * Заказчик 30.08: «У меня есть пять таких Маш, каждой поставил лимит по 100. Это же 500
 * влезает, а у меня как у владельца может быть всего 100 токенов. Токены — это не просто
 * цифра, это деньги, которые я передаю своему пользователю».
 *
 * Раньше «индивидуальный лимит» ничего не выделял: сотрудник тратил из кошелька владельца,
 * а лимит показывался ему как баланс. Сумма лимитов не была ничем ограничена, и владелец
 * не знал, сколько у него останется. Теперь это НАСТОЯЩИЙ перевод: у владельца стало
 * меньше, у сотрудника появилось.
 *
 * Первая же выдача переводит сотрудника на собственный кошелёк (`balanceMode:
 * 'individual'`) — иначе начисление вернулось бы владельцу: `changeCoins` для общего
 * баланса пишет в кошелёк владельца, и выдача была бы переводом самому себе.
 *
 * Изъятие — та же операция со знаком минус, и у неё свой крайний случай: часть выданного
 * сотрудник мог уже потратить. Забираем сколько осталось и говорим об этом числом, а не
 * уводим баланс в минус.
 *
 * @param {{ownerId: string, subId: string, amount: number, actorId?: string}} p
 *   `amount` > 0 — выдать сотруднику, < 0 — изъять у него.
 * @returns {Promise<{moved: number, ownerLeft: number, subLeft: number, partial: boolean}>}
 */
export async function transferCoins({ ownerId, subId, amount, actorId } = {}) {
  const owner = String(ownerId || '')
  const sub = String(subId || '')
  const want = Math.round((Number(amount) || 0) * COIN_PRECISION) / COIN_PRECISION
  if (!owner || !sub) throw new Error('Не указан владелец или сотрудник')
  if (owner === sub) throw new Error('Перевод самому себе смысла не имеет')
  if (!want) throw new Error('Укажите количество токенов')

  const { getUser, updateUser } = await import('./users.js')
  const subUser = await getUser(sub).catch(() => null)
  if (!subUser) throw new Error('Сотрудник не найден')
  if (String(subUser.parentId || '') !== owner) throw new Error('Это не ваш сотрудник')

  if (want > 0) {
    const { coins: ownerCoins } = await getBalance(owner)
    if (ownerCoins < want) {
      throw new Error(`У вас ${normCoins(ownerCoins)} ⚡ — выдать ${want} нельзя. Токены переходят сотруднику с вашего баланса.`)
    }
    // Порядок важен: сначала свой кошелёк, потом начисление. Иначе начисление ушло бы
    // владельцу же — сотрудник с общим балансом кошелька не имеет.
    if (subUser.balanceMode !== 'individual') await updateUser(sub, { balanceMode: 'individual' })
    await changeCoins(-want, `Выдача токенов сотруднику ${subUser.name || subUser.email || sub}`, owner, 'transfer_out')
    await changeCoins(want, `Получено от владельца`, sub, 'transfer_in')
    const [{ coins: ownerLeft }, { coins: subLeft }] = await Promise.all([getBalance(owner), getBalance(sub)])
    return { moved: want, ownerLeft, subLeft, partial: false }
  }

  // Изъятие: забираем не больше, чем у сотрудника осталось.
  const { coins: subCoins } = await getBalance(sub)
  const take = Math.min(subCoins, Math.abs(want))
  if (take <= 0) {
    const [{ coins: ownerLeft }] = await Promise.all([getBalance(owner)])
    return { moved: 0, ownerLeft, subLeft: subCoins, partial: true }
  }
  await changeCoins(-take, 'Изъятие токенов владельцем', sub, 'transfer_out')
  await changeCoins(take, `Возврат от сотрудника ${subUser.name || subUser.email || sub}`, owner, 'transfer_in')
  const [{ coins: ownerLeft }, { coins: subLeft }] = await Promise.all([getBalance(owner), getBalance(sub)])
  return { moved: take, ownerLeft, subLeft, partial: take < Math.abs(want) }
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
/**
 * @param {'purchase'|'grant'} [kind] откуда деньги: клиент заплатил или админ выдал руками.
 * Без пометки считается оплатой — так вели себя все записи до 26.08.
 */
export async function changeUsd(amount, reason = '', userId, kind, modules) {
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
    const result = { before, after, applied: Math.round((after - before) * 100) / 100, reason, userId: k, currency: 'usd', kind: kind || null, modules }
    if (result.applied) await appendWalletEntry(result).catch(() => {})
    return result
  }
  let result = null
  await mutateJson(BALANCE_FILE(), (all) => {
    const cur = (all && all[k]) || {}
    const before = normUsd(cur?.usd ?? 0)
    const after = normUsd(before + delta)
    result = { before, after, applied: Math.round((after - before) * 100) / 100, reason, userId: k, currency: 'usd', kind: kind || null, modules }
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
    await changeCoins(tokens, `Куплено за $${spend.toFixed(2)}`, userId, 'purchase')
  } catch (e) {
    // Деньги уже списаны — возвращаем их, иначе клиент теряет средства молча.
    await changeUsd(spend, 'Возврат: не удалось начислить токены', userId).catch(() => {})
    throw e
  }
  return { spentUsd: spend, tokens, rate, balance: await getBalance(userId) }
}
