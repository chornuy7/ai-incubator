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
    const BASE = 'input_share, max_input_chars, max_output_chars, chars_per_token'
    const VISION = 'vision_input_tokens, vision_output_tokens'
    const overrides = async () => {
      // Колонки vision появляются миграцией 2026-08-22-max-cost-image.sql. Пока её не
      // накатили — читаем без них, иначе весь блок цен молча уходил бы в null и в
      // админке пропадала бы строка максимума.
      const first = await db.from('price_overrides').select(`${BASE}, ${VISION}`).eq('id', 'default').maybeSingle()
      if (!first.error) return first
      return db.from('price_overrides').select(BASE).eq('id', 'default').maybeSingle()
    }
    const [{ data: rows }, { data: ov }] = await Promise.all([
      db.from('model_prices').select('model, input_per_1m, output_per_1m'),
      overrides(),
    ])
    if (!rows) return _dbCache
    const prices = {}
    for (const r of rows) prices[String(r.model).toLowerCase()] = { input: Number(r.input_per_1m) || 0, output: Number(r.output_per_1m) || 0 }
    _dbCache = {
      prices,
      share: ov?.input_share == null ? null : Number(ov.input_share),
      limits: {
        inChars: Number(ov?.max_input_chars) || 0,
        outChars: Number(ov?.max_output_chars) || 0,
        charsPerToken: Number(ov?.chars_per_token) || 0,
        // Отдельный vision-вызов: картинку шлём detail:'low' (фиксированные 85 токенов
        // у OpenAI) + промпт; ответ ограничен max_tokens. Тоже из БД, не из кода.
        visionIn: Number(ov?.vision_input_tokens) || 0,
        visionOut: Number(ov?.vision_output_tokens) || 0,
      },
      ts: Date.now(),
    }
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


/**
 * MR-149: МАКСИМАЛЬНАЯ стоимость одного ИИ-действия у поставщика.
 *
 * Логика заказчика: ИИ читает пост (максимум N символов) и генерирует ответ (максимум M
 * символов) — это худший случай, от него и ставим цену. Считаем ЧЕСТНО по двум ставкам:
 * вход по input-цене, ответ по output-цене (output обычно вчетверо дороже), а не по
 * смешанной ставке, как фактический расход.
 *
 * Лимиты и «символов на токен» берём из БД (price_overrides), в коде их не держим.
 * @returns {Promise<{usd:number, inTokens:number, outTokens:number, inChars:number, outChars:number, charsPerToken:number}|null>}
 */
export async function maxActionCost(model = process.env.OPENAI_MODEL || DEFAULT_MODEL) {
  const db = await fromDb()
  const p = (db && priceOfIn(db.prices, model)) || priceOf(model)
  const lim = db?.limits
  if (!p || !lim || !lim.charsPerToken || (!lim.inChars && !lim.outChars)) return null
  const inTokens = Math.ceil(lim.inChars / lim.charsPerToken)
  const outTokens = Math.ceil(lim.outChars / lim.charsPerToken)
  const round = (v) => Math.round(v * 1e10) / 1e10
  const usd = round((inTokens * p.input + outTokens * p.output) / 1_000_000)

  /*
   * Созвон 12.08: «цена за действие должна высчитываться с МАКСИМАЛЬНОЙ цены за одно
   * действие… включая написание текста плюс картинки».
   *
   * Когда модуль разбирает изображение, к генерации добавляется ОТДЕЛЬНЫЙ vision-вызов —
   * он идёт СВЕРХ обычного, а не вместо него. Считая только текст, мы занижали максимум,
   * то есть занижали и цену, которая от него ставится.
   */
  const visionUsd = round((lim.visionIn * p.input + lim.visionOut * p.output) / 1_000_000)
  const withImage = round(usd + visionUsd)

  return {
    usd,                                  // максимум без картинки: прочитать пост + сгенерировать ответ
    withImage,                            // он же плюс разбор изображения
    max: withImage > usd ? withImage : usd, // худший случай — от него ставится цена
    visionUsd,
    inTokens, outTokens,
    visionIn: lim.visionIn, visionOut: lim.visionOut,
    inChars: lim.inChars, outChars: lim.outChars, charsPerToken: lim.charsPerToken,
  }
}
