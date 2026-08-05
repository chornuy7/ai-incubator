/**
 * §10.4/§10.1: ЦЕНЫ ИЗ ДАННЫХ, А НЕ ИЗ КОДА.
 *
 * Требование созвона 27.07: «внутри самого кода этого вообще быть не должно» —
 * цены/скидки редактируются из админки, не правкой констант. Здесь тонкий слой
 * поверх кода-констант (`pricing.js`): файл `data/prices.json` хранит ТОЛЬКО
 * переопределения. Пустой стор = поведение ровно как в коде, поэтому существующие
 * тесты не меняются, а миграция на Supabase later — это замена бэкенда стора,
 * интерфейс (`effectivePrices`/`setOverrides`) остаётся.
 *
 * Что переопределяемо: цена подписки на модуль ($/мес) и цена действия (⚡),
 * пакеты монет, годовая скидка, курс токенов, себестоимость токена ($) и множитель
 * за анализ картинки (§10.5).
 *
 * §10.1: себестоимость токена НЕ ждём «сверху» — считаем сами из прайса текущей модели
 * (lib/modelPricing.js). Админ может переопределить число вручную; пусто = авто-расчёт.
 */
import { dataPath, readJson, mutateJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'
import { tokenUsdForModel, currentModel } from './lib/modelPricing.js'

function sb() { return supabaseEnabled() ? getSupabase() : null }

/** Строка price_overrides (id='default') ↔ объект переопределений {modules, annualDiscount, …}. */
function rowToOverrides(row) {
  if (!row) return {}
  const o = {}
  if (row.modules && Object.keys(row.modules).length) o.modules = row.modules
  if (row.annual_discount != null) o.annualDiscount = Number(row.annual_discount)
  if (row.coins_per_1k_tokens != null) o.coinsPer1kTokens = Number(row.coins_per_1k_tokens)
  if (row.token_usd != null) o.tokenUsd = Number(row.token_usd)
  if (row.image_multiplier != null) o.imageMultiplier = Number(row.image_multiplier)
  if (Array.isArray(row.coin_packs)) o.coinPacks = row.coin_packs
  if (Array.isArray(row.periods)) o.periods = row.periods
  return o
}

/**
 * §11.2: периоды подписки со скидками.
 *
 * По звонку 29.07 период — не «месяц/год» в коде, а генерируемый список: единица
 * (неделя/месяц/год) + количество + скидка. Здесь только нормализация: единица из
 * белого списка, count в разрешённых для неё пределах (нед. 1–4, мес. 1–6, год 1–5 —
 * прямо со звонка), скидка 0–90%. Мусор молча отбрасываем, дубли схлопываем.
 */
const PERIOD_LIMITS = { week: 4, month: 6, year: 5 }
export const PERIOD_UNITS = Object.keys(PERIOD_LIMITS)
/** Длительность периода в месяцах — для пересчёта цены (неделя ≈ 1/4 месяца). */
export function periodMonths(p) {
  const n = Number(p?.count) || 1
  return p?.unit === 'year' ? n * 12 : p?.unit === 'week' ? n / 4 : n
}
export function normalizePeriods(list) {
  if (!Array.isArray(list)) return null
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const unit = String(raw?.unit || '')
    const max = PERIOD_LIMITS[unit]
    if (!max) continue
    const count = Math.round(Number(raw?.count))
    if (!Number.isFinite(count) || count < 1 || count > max) continue
    const key = `${unit}:${count}`
    if (seen.has(key)) continue
    seen.add(key)
    const d = Number(raw?.discount)
    out.push({ unit, count, discount: Number.isFinite(d) ? Math.min(0.9, Math.max(0, d)) : 0 })
  }
  // По возрастанию длительности — так их и показывают в переключателе.
  out.sort((a, b) => periodMonths(a) - periodMonths(b))
  return out.length ? out : null
}
function overridesToRow(ov) {
  return {
    id: 'default',
    modules: ov.modules || {},
    annual_discount: ov.annualDiscount ?? null,
    coins_per_1k_tokens: ov.coinsPer1kTokens ?? null,
    token_usd: ov.tokenUsd ?? null,
    image_multiplier: ov.imageMultiplier ?? null,
    coin_packs: ov.coinPacks ?? null,
    periods: ov.periods ?? null,
    updated_at: new Date().toISOString(),
  }
}

/** Чистая логика мерджа patch в текущие overrides — общая для файла и БД. */
function mergeOverrides(cur, patch) {
  const clean = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v))
  cur = { ...(cur || {}) }
  if (patch.modules) {
    const mods = { ...(cur.modules || {}) }
    for (const [key, val] of Object.entries(patch.modules)) {
      if (MODULE_MONTH_PRICE[key] === undefined) continue
      const entry = { ...(mods[key] || {}) }
      if ('month' in val) {
        const m = clean(val.month)
        if (m === undefined || m === MODULE_MONTH_PRICE[key]) delete entry.month
        else if (Number.isFinite(m) && m >= 0) entry.month = round2(m)
      }
      if ('action' in val) {
        const a = clean(val.action)
        const def = ACTION_PRICE[key] ?? 0
        if (a === undefined || a === def) delete entry.action
        else if (Number.isFinite(a) && a >= 0) entry.action = a
      }
      // §3 (MR-21): подарочные токены на модуль — дефолт 0; храним только заданное >0.
      if ('gift' in val) {
        const g = clean(val.gift)
        if (g === undefined || g === 0) delete entry.gift
        else if (Number.isFinite(g) && g >= 0) entry.gift = Math.round(g)
      }
      if (Object.keys(entry).length) mods[key] = entry; else delete mods[key]
    }
    cur.modules = mods
  }
  for (const field of ['annualDiscount', 'coinsPer1kTokens', 'tokenUsd', 'imageMultiplier']) {
    if (field in patch) {
      const n = clean(patch[field])
      if (n === undefined) delete cur[field]
      else if (Number.isFinite(n) && n >= 0) cur[field] = n
    }
  }
  if (Array.isArray(patch.coinPacks)) {
    cur.coinPacks = patch.coinPacks
      .map((p) => ({ coins: Number(p.coins) || 0, price: round2(p.price), best: !!p.best }))
      .filter((p) => p.coins > 0 && p.price > 0)
  }
  // §11.2: periods — пустой массив означает «вернуть дефолт», поэтому удаляем ключ,
  // а не сохраняем пустоту (иначе переключатель периодов исчез бы совсем).
  if ('periods' in patch) {
    const norm = normalizePeriods(patch.periods)
    if (norm) cur.periods = norm; else delete cur.periods
  }
  return cur
}
import {
  MODULE_MONTH_PRICE, ACTION_PRICE, COIN_PACKS, ANNUAL_DISCOUNT,
} from './pricing.js'
import { COINS_PER_1K_TOKENS } from './tokenLedger.js'
import { moduleTitle } from './lib/moduleTitles.js'

const PRICES_FILE = () => process.env.PRICES_FILE || dataPath('prices.json')

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100

/** Сырые переопределения из файла (или пусто). @returns {Promise<object>} */
export async function getOverrides() {
  const db = sb()
  if (db) {
    const { data } = await db.from('price_overrides').select('*').eq('id', 'default').maybeSingle()
    return rowToOverrides(data)
  }
  const raw = await readJson(PRICES_FILE(), {})
  return raw && typeof raw === 'object' ? raw : {}
}

/**
 * Эффективные цены = коды-дефолты, перекрытые переопределениями из стора.
 * Отдаёт и «плоские» карты для расчёта (`monthMap`/`actionMap`), и человекочитаемый
 * список модулей для админки/витрины.
 */
export async function effectivePrices() {
  const ov = await getOverrides()
  const ovMod = ov.modules || {}

  const monthMap = {}
  const actionMap = {}
  const giftMap = {} // §3 (MR-21): подарочные токены на модуль
  const modules = Object.keys(MODULE_MONTH_PRICE).map((key) => {
    const month = ovMod[key]?.month ?? MODULE_MONTH_PRICE[key]
    const action = ovMod[key]?.action ?? (ACTION_PRICE[key] ?? 0)
    const gift = ovMod[key]?.gift ?? 0
    monthMap[key] = month
    actionMap[key] = action
    giftMap[key] = gift
    return {
      key,
      title: moduleTitle(key),
      month: round2(month),
      action: Number(action),
      gift: Number(gift),
      // Помечаем, что переопределено — админке показать «изменено», а не «дефолт».
      overridden: { month: ovMod[key]?.month !== undefined, action: ovMod[key]?.action !== undefined, gift: ovMod[key]?.gift !== undefined },
    }
  })

  // §10.1: себестоимость токена считаем САМИ из прайса текущей модели, а не ждём числа
  // «сверху». Админский override (число) побеждает; иначе — авто-расчёт по модели.
  // Флаги auto/model нужны админке, чтобы показать «рассчитано из gpt-4o-mini» и дать
  // переопределить, а не гадать, откуда цифра.
  const tokenUsdManual = typeof ov.tokenUsd === 'number'
  const autoTokenUsd = tokenUsdForModel()
  const tokenUsd = tokenUsdManual ? ov.tokenUsd : autoTokenUsd

  return {
    modules,
    monthMap,
    actionMap,
    giftMap,
    coinPacks: Array.isArray(ov.coinPacks) && ov.coinPacks.length ? ov.coinPacks : COIN_PACKS,
    annualDiscount: typeof ov.annualDiscount === 'number' ? ov.annualDiscount : ANNUAL_DISCOUNT,
    // §11.2: список периодов. Пока админ его не задал — прежнее поведение (месяц + год
    // со скидкой annualDiscount), чтобы витрина не изменилась сама по себе.
    periods: normalizePeriods(ov.periods) || [
      { unit: 'month', count: 1, discount: 0 },
      { unit: 'year', count: 1, discount: typeof ov.annualDiscount === 'number' ? ov.annualDiscount : ANNUAL_DISCOUNT },
    ],
    coinsPer1kTokens: typeof ov.coinsPer1kTokens === 'number' ? ov.coinsPer1kTokens : COINS_PER_1K_TOKENS,
    tokenUsd,
    tokenUsdAuto: !tokenUsdManual, // true = рассчитано из модели, false = задано вручную
    tokenUsdComputed: autoTokenUsd, // ВСЕГДА цена из модели (даже при ручном override) — для подсказки «авто»
    tokenUsdModel: currentModel(), // из какой модели считается себестоимость
    imageMultiplier: typeof ov.imageMultiplier === 'number' ? ov.imageMultiplier : 4,
  }
}

/**
 * §10.4: курс «монета → $» — лучший (оптовый) курс из пакетов монет. Один источник
 * правды для показа $-эквивалента баланса/пополнений (иначе правило дублировалось
 * по эндпоинтам и могло разойтись). 0 — если пакетов/цен нет.
 * @returns {Promise<number>} $ за одну монету
 */
export async function coinUsdRate() {
  const packs = (await effectivePrices()).coinPacks || []
  const rates = packs.filter((p) => p.coins > 0 && p.price > 0).map((p) => p.price / p.coins)
  return rates.length ? Math.min(...rates) : 0
}

/**
 * Записать переопределения. Пишем ТОЛЬКО отличие от дефолта: цена, равная коду,
 * удаляется из стора — тогда изменение дефолта в будущем не будет молча перекрыто
 * «застывшим» значением, и «изменено» в админке отражает реальность.
 * @param {object} patch { modules?: {key:{month?,action?}}, coinPacks?, annualDiscount?, coinsPer1kTokens?, tokenUsd?, imageMultiplier? }
 */
export async function setOverrides(patch = {}) {
  const db = sb()
  if (db) {
    const cur = await getOverrides()
    const next = mergeOverrides(cur, patch)
    const row = overridesToRow(next)
    const { error } = await db.from('price_overrides').upsert(row, { onConflict: 'id' })
    // §11.2: колонка periods добавляется миграцией (supabase/migrations/…-price-periods.sql).
    // Пока её не применили, сохраняем всё остальное, а не роняем правку цен целиком.
    if (error && /periods/i.test(error.message || '')) {
      const { periods, ...rest } = row
      void periods
      await db.from('price_overrides').upsert(rest, { onConflict: 'id' })
      console.warn('[prices] колонка periods отсутствует — примените supabase/migrations/2026-07-30-price-periods.sql')
    } else if (error) {
      throw new Error(error.message)
    }
    return effectivePrices()
  }
  await mutateJson(PRICES_FILE(), (raw) => mergeOverrides(raw && typeof raw === 'object' ? raw : {}, patch), {})
  return effectivePrices()
}
