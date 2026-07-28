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
export function tokenUsdForModel(model = process.env.OPENAI_MODEL || DEFAULT_MODEL) {
  const p = priceOf(model)
  if (!p) return null
  const blendedPer1M = p.input * INPUT_SHARE + p.output * (1 - INPUT_SHARE)
  // $/токен = ($/1e6 токенов) / 1e6. Округляем до 12 знаков — цена токена очень мелкая.
  return Math.round((blendedPer1M / 1_000_000) * 1e12) / 1e12
}

/** Имя модели, по которой сейчас считается себестоимость (для показа в админке). */
export function currentModel() {
  return process.env.OPENAI_MODEL || DEFAULT_MODEL
}
