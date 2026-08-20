/**
 * §10.1: себестоимость токена ИИ в долларах — считаем САМИ из прайса модели, а не
 * ждём числа «сверху». Заказчик правит наценку/курс в админке, но базовая цена токена
 * не должна быть пустой: она выводится из реальной стоимости модели у OpenAI.
 *
 * Цены — $ за 1 млн токенов (input/output), как их публикует OpenAI. Держим таблицей,
 * чтобы при смене OPENAI_MODEL пересчёт шёл сам, а обновление прайса было правкой одной
 * строки, а не поиском по коду.
 *
 * ⚠️ Это СЕБЕСТОИМОСТЬ (сколько платим OpenAI), а не цена для клиента. Наценку/курс
 * «токен → монета» задаёт админка поверх этого (priceStore).
 */

/** $ за 1 000 000 токенов. Источник — прайс OpenAI. Обновлять здесь при изменении. */
export const MODEL_PRICES_PER_1M = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4.1': { input: 2.00, output: 8.00 },
  'o4-mini': { input: 1.10, output: 4.40 },
}

/** Модель, если ничего не задано — та же, что и в генераторах. */
export const DEFAULT_MODEL = 'gpt-4o-mini'

/**
 * Доля input в типичном запросе платформы. Промпт (пост/цель/инструкция) обычно длиннее
 * короткого ответа (коммент ≤120 токенов), поэтому вход преобладает. Значение вынесено
 * константой — если структура запросов изменится, правится одним числом.
 */
const INPUT_SHARE = 0.75

// MR-149 (созвон 19.08): «в коде не должно быть статичных значений по прайсам». Цены моделей
// живут в таблице model_prices, доля input — в price_overrides.input_share (а лучше считается
// по факту из журнала). Здешние константы остаются ТОЛЬКО для файлового режима (dev/тесты,
// где БД нет). Кэш 5 мин: прайс модели меняется раз в полгода, а зовут его на каждом расчёте.
let _dbCache = null // { prices: {model:{input,output}}, share: number|null, ts }
const DB_TTL = 5 * 60_000
export function invalidateModelPrices() { _dbCache = null }

async function fromDb() {
  const { supabaseEnabled, getSupabase } = await import('./supabase.js')
  if (!supabaseEnabled()) return null
  if (_dbCache && Date.now() - _dbCache.ts < DB_TTL) return _dbCache
  try {
    const db = getSupabase()
    const [{ data: rows }, { data: ov }] = await Promise.all([
      db.from('model_prices').select('model, input_per_1m, output_per_1m'),
      db.from('price_overrides').select('input_share').eq('id', 'default').maybeSingle(),
    ])
    if (!rows) return _dbCache
    const prices = {}
    for (const r of rows) prices[String(r.model).toLowerCase()] = { input: Number(r.input_per_1m) || 0, output: Number(r.output_per_1m) || 0 }
    _dbCache = { prices, share: ov?.input_share == null ? null : Number(ov.input_share), ts: Date.now() }
    return _dbCache
  } catch { return _dbCache }
}

/**
 * Доля input ПО ФАКТУ: из журнала расхода (prompt_tokens / total). Догадка «75/25» была
 * ровно тем, за что заказчик и ругал — число из ниоткуда. Если записей нет, берём значение
 * из БД, и лишь в файловом режиме — код-константу.
 */
async function realInputShare(fallback) {
  try {
    const { readLedger } = await import('../tokenLedger.js')
    const rows = await readLedger({ limit: 500 })
    let pt = 0; let tot = 0
    for (const r of rows) { pt += Number(r.promptTokens) || 0; tot += Number(r.tokens) || 0 }
    if (tot > 0 && pt > 0) return Math.min(1, Math.max(0, pt / tot))
  } catch { /* журнал недоступен — берём заданное значение */ }
  return fallback
}

/** Прайс по имени в ЛЮБОЙ карте (частичное совпадение: 'gpt-4o-mini-2024-…' → 'gpt-4o-mini'). */
function priceOfIn(map, model) {
  const m = String(model || '').toLowerCase().trim()
  if (map[m]) return map[m]
  const key = Object.keys(map).filter((k) => m.includes(k)).sort((a, b) => b.length - a.length)[0]
  return key ? map[key] : null
}

/** Прайс модели по имени (частичное совпадение: 'gpt-4o-mini-2024-…' → 'gpt-4o-mini'). */
function priceOf(model) {
  const m = String(model || '').toLowerCase().trim()
  if (MODEL_PRICES_PER_1M[m]) return MODEL_PRICES_PER_1M[m]
  // Длиннейший ключ-префикс: 'gpt-4o-mini' должен победить 'gpt-4o' для 'gpt-4o-mini-...'.
  const key = Object.keys(MODEL_PRICES_PER_1M)
    .filter((k) => m.includes(k))
    .sort((a, b) => b.length - a.length)[0]
  return key ? MODEL_PRICES_PER_1M[key] : null
}

/**
 * Себестоимость ОДНОГО токена в долларах для модели — смешанная ставка input/output.
 * @param {string} [model] по умолчанию OPENAI_MODEL / gpt-4o-mini
 * @returns {number|null} $/токен (например 0.0000002625) или null, если модель незнакома
 */
export async function tokenUsdForModel(model = process.env.OPENAI_MODEL || DEFAULT_MODEL) {
  const db = await fromDb()
  const p = (db && priceOfIn(db.prices, model)) || priceOf(model)
  if (!p) return null
  const share = await realInputShare(db?.share ?? INPUT_SHARE)
  const blendedPer1M = p.input * share + p.output * (1 - share)
  // $/токен = ($/1e6 токенов) / 1e6. Округляем до 12 знаков — цена токена очень мелкая.
  return Math.round((blendedPer1M / 1_000_000) * 1e12) / 1e12
}

/** Имя модели, по которой сейчас считается себестоимость (для показа в админке). */
export function currentModel() {
  return process.env.OPENAI_MODEL || DEFAULT_MODEL
}
