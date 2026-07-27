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
 * пакеты монет, годовая скидка, курс токенов, курс токен→доллар и множитель за
 * анализ картинки (§10.5). Два последних — новые из звонка, у них placeholder,
 * который заказчик проставит из админки, когда Николай пришлёт числа.
 */
import { dataPath, readJson, mutateJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

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
  return o
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
  const modules = Object.keys(MODULE_MONTH_PRICE).map((key) => {
    const month = ovMod[key]?.month ?? MODULE_MONTH_PRICE[key]
    const action = ovMod[key]?.action ?? (ACTION_PRICE[key] ?? 0)
    monthMap[key] = month
    actionMap[key] = action
    return {
      key,
      title: moduleTitle(key),
      month: round2(month),
      action: Number(action),
      // Помечаем, что переопределено — админке показать «изменено», а не «дефолт».
      overridden: { month: ovMod[key]?.month !== undefined, action: ovMod[key]?.action !== undefined },
    }
  })

  return {
    modules,
    monthMap,
    actionMap,
    coinPacks: Array.isArray(ov.coinPacks) && ov.coinPacks.length ? ov.coinPacks : COIN_PACKS,
    annualDiscount: typeof ov.annualDiscount === 'number' ? ov.annualDiscount : ANNUAL_DISCOUNT,
    coinsPer1kTokens: typeof ov.coinsPer1kTokens === 'number' ? ov.coinsPer1kTokens : COINS_PER_1K_TOKENS,
    // Новые из звонка §10.1/§10.5. Пока не заданы — null: интерфейс покажет
    // «не задано», а не выдуманное число.
    tokenUsd: typeof ov.tokenUsd === 'number' ? ov.tokenUsd : null,
    imageMultiplier: typeof ov.imageMultiplier === 'number' ? ov.imageMultiplier : 4,
  }
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
    await db.from('price_overrides').upsert(overridesToRow(next), { onConflict: 'id' })
    return effectivePrices()
  }
  await mutateJson(PRICES_FILE(), (raw) => mergeOverrides(raw && typeof raw === 'object' ? raw : {}, patch), {})
  return effectivePrices()
}
