/**
 * НАСТРОЙКИ ФОНОВЫХ ЗАДАЧ (крон) — из админки, а не из кода.
 *
 * Просьба владельца 26.08: «в админку нужно вынести все настройки по кроне». До этого
 * интервалы были константами в шести разных файлах: чтобы изменить, как часто идёт
 * ревизия базы или проверка парка, приходилось править код и выкатываться. Хуже другое —
 * посмотреть, что вообще крутится в фоне и с какой частотой, было негде.
 *
 * Хранение — общий kv (`app_settings`), то есть БД, когда она включена. Настройка,
 * лежащая в файле на диске одного сервера, при втором инстансе разъедется.
 *
 * Значения по умолчанию — те же, что были в коде, чтобы выкат ничего не изменил.
 */
import { dataPath } from './lib/jsonStore.js'
import { kvRead, kvWrite } from './lib/kvStore.js'

const FILE = () => dataPath('cron-settings.json')

/**
 * Каждая настройка — с описанием и границами: админка рисует форму по этому же
 * описанию, и правило «что можно вводить» живёт в одном месте, а не в верстке.
 */
export const CRON_FIELDS = [
  { key: 'parserTickMin', label: 'Ревизия базы: как часто заглядывать', unit: 'мин', def: 30, min: 5, max: 720,
    hint: 'Тик планировщика. Сам решает, каким запросам пора — частый тик не создаёт нагрузки.' },
  { key: 'parserPeriodH', label: 'Ревизия базы: как часто обновлять запрос', unit: 'ч', def: 12, min: 1, max: 720,
    hint: 'Решение 26.08: раз в 12 часов. Через столько сохранённый запрос собирается заново.' },
  { key: 'parserParallel', label: 'Ревизия базы: одновременно запросов', unit: 'шт', def: 3, min: 1, max: 10,
    hint: 'Больше трёх сервисных аккаунтов, разом начавших один и тот же поиск, выглядят машиной.' },
  { key: 'parserStaggerMinSec', label: 'Ревизия базы: пауза между стартами, от', unit: 'с', def: 20, min: 0, max: 600 },
  { key: 'parserStaggerMaxSec', label: 'Ревизия базы: пауза между стартами, до', unit: 'с', def: 90, min: 0, max: 3600 },
  { key: 'parserWaitMin', label: 'Ревизия базы: ждать завершения не дольше', unit: 'мин', def: 40, min: 5, max: 240 },
  { key: 'parserAccounts', label: 'Ревизия базы: аккаунтов на один запрос', unit: 'шт', def: 2, min: 1, max: 10 },

  { key: 'healthTickMin', label: 'Проверка парка: как часто заглядывать', unit: 'мин', def: 60, min: 5, max: 1440 },
  { key: 'healthEveryH', label: 'Проверка парка: как часто проверять один аккаунт', unit: 'ч', def: 12, min: 1, max: 720 },
  { key: 'healthPerTick', label: 'Проверка парка: аккаунтов за один заход', unit: 'шт', def: 5, min: 1, max: 50,
    hint: 'Каждый — это подключение к Telegram. Большое число за раз даёт всплеск трафика с одного сервера.' },

  { key: 'statsTickMin', label: 'Статистика каналов: интервал', unit: 'мин', def: 15, min: 5, max: 1440 },
  { key: 'trustTickMin', label: 'Пересчёт trust-score: интервал', unit: 'мин', def: 10, min: 1, max: 1440 },
  { key: 'proxyTickMin', label: 'Проверка прокси: интервал', unit: 'мин', def: 30, min: 5, max: 1440 },
  { key: 'creditTickH', label: 'Начисление токенов подписки: интервал', unit: 'ч', def: 6, min: 1, max: 24,
    hint: 'Начисление идемпотентно (раз в месяц по дню оплаты) — частый тик ничего не удваивает.' },
  { key: 'campaignTickMin', label: 'Расписания кампаний: интервал', unit: 'мин', def: 1, min: 1, max: 60,
    hint: 'Кампания стартует по расписанию с точностью до этого интервала.' },
]

const DEFAULTS = Object.fromEntries(CRON_FIELDS.map((f) => [f.key, f.def]))

let cache = { ...DEFAULTS }
let loaded = false

/** Привести значение к границам поля: из админки может прийти что угодно. */
function clamp(key, value) {
  const f = CRON_FIELDS.find((x) => x.key === key)
  if (!f) return null
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return f.def
  return Math.min(f.max, Math.max(f.min, n))
}

export async function loadCronSettings() {
  const data = await kvRead('cron-settings', FILE, {})
  const next = { ...DEFAULTS }
  for (const [k, v] of Object.entries(data || {})) {
    const c = clamp(k, v)
    if (c !== null) next[k] = c
  }
  cache = next
  loaded = true
  return { ...cache }
}

export async function getCronSettings() {
  if (!loaded) await loadCronSettings()
  return { ...cache }
}

/**
 * Синхронный доступ для планировщиков: они читают настройку на каждом тике, поэтому
 * ждать загрузки нельзя. До первой загрузки отдаём значения по умолчанию — те же, что
 * были в коде, так что поведение не меняется.
 */
export function getCronSync() {
  return { ...cache }
}

export async function setCronSettings(patch = {}) {
  if (!loaded) await loadCronSettings()
  const next = { ...cache }
  for (const [k, v] of Object.entries(patch)) {
    const c = clamp(k, v)
    if (c !== null) next[k] = c
  }
  cache = next
  await kvWrite('cron-settings', FILE, next)
  return { ...cache }
}
