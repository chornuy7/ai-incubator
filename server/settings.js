/**
 * §6: настройки безопасности, которые нужно менять без правки кода.
 *
 * Первая из них — порог trust для рассылки. Он был зашит константой 70, но на реальном
 * пуле оказалось, что у большинства купленных аккаунтов trust 65–70: порог 70 блокировал
 * почти всё. Значение зависит от того, какие аккаунты закупаются, поэтому это настройка,
 * а не константа.
 *
 * Хранение — JSON `data/settings.json`; путь через env SETTINGS_FILE (тесты).
 */
import { dataPath, readJson, mutateJson } from './lib/jsonStore.js'
import { kvRead, kvWrite } from './lib/kvStore.js'

const SETTINGS_FILE = process.env.SETTINGS_FILE || dataPath('settings.json')

/** Значения по умолчанию. Меняются через API, но всегда есть, даже если файла нет. */
export const DEFAULT_SETTINGS = {
  /**
   * Минимальный trust аккаунта для рассылки. Ниже порога аккаунт в рассылку не берётся —
   * кроме случая, когда админ осознанно разрешил запуск (см. `allowLowTrust` у задачи).
   */
  mailingMinTrust: 65,
  /**
   * MR-144: сколько задач выполняется одновременно (остальные ждут в очереди). Раньше было
   * зашито в MAX_CONCURRENT (env). Настраивается владельцем рабочего пространства; значение
   * показывается на дашборде задач.
   */
  maxParallelTasks: 3,
}

/** Границы допустимых значений — чтобы настройкой нельзя было отключить защиту молча. */
const BOUNDS = {
  mailingMinTrust: [0, 100],
  maxParallelTasks: [1, 20],
}

/** Привести значение к числу в границах; вернуть null, если пришёл мусор. */
function clampSetting(key, value) {
  const b = BOUNDS[key]
  if (!b) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(b[1], Math.max(b[0], Math.round(n)))
}

export async function getSettings() {
  // §10.2: настройки — из БД (app_settings), файл остаётся для локального режима.
  const saved = await kvRead('settings', () => SETTINGS_FILE, {})
  return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) }
}

/** Одна настройка — с дефолтом, если файла/ключа нет. @param {keyof DEFAULT_SETTINGS} key */
export async function getSetting(key) {
  return (await getSettings())[key]
}

/**
 * Обновить настройки. Неизвестные ключи игнорируются, значения зажимаются в границы —
 * иначе через API можно было бы выставить порог -1 и незаметно снять защиту.
 * @param {object} patch @returns {Promise<object>} актуальные настройки
 */
export async function updateSettings(patch = {}) {
  // Читаем текущее из того же источника, куда пишем: иначе в режиме БД правка
  // затирала бы настройки значениями из устаревшего файла.
  const cur = await getSettings()
  const next = { ...cur }
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue
    const clean = clampSetting(k, v)
    if (clean !== null) next[k] = clean
  }
  await kvWrite('settings', () => SETTINGS_FILE, next)
  return next
}
