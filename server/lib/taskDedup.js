/**
 * §7: проверка уникальности задачи перед запуском — не создавать вторую идентичную
 * активную задачу (те же аккаунты + цель + цели/каналы). Не «сканирование», а простая
 * проверка по подписи. Чистые функции — тестируются изолированно.
 */

/** Активные (незавершённые) статусы задачи. */
export const ACTIVE_TASK_STATUSES = new Set(['running', 'queued', 'paused'])

/**
 * Подпись задачи для сравнения: аккаунты + цель + цели/каналы + ключевые слова.
 *
 * Ключевые слова обязательны: семейство парсеров (их пять) работает не по каналам,
 * а по `keywords`, поэтому без них подпись вырождалась в один аккаунт. Проверено на
 * прогоне 21–22.07 (тест 6.6): поиск «crypto» и поиск «nft» одним аккаунтом давали
 * идентичную подпись `{"a":["acc_1"],"g":"","t":[]}` — то есть вторая, СОВЕРШЕННО
 * другая выгрузка отклонялась как «идентичная задача уже запущена», а для парсеров
 * проверка вырождалась в «одна задача на аккаунт», дублируя лок аккаунта.
 *
 * @param {{accountIds?: string[], goalId?: string|null, channels?: string[], targets?: string[], keywords?: string[]}} settings
 * @returns {string}
 */
export function taskSignature(settings = {}) {
  const accs = [...new Set((settings.accountIds || []).map((x) => String(x)))].sort()
  const tgts = [...new Set((settings.channels || settings.targets || []).map((x) => String(x)))].sort()
  const kws = [...new Set((settings.keywords || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))].sort()
  const goal = settings.goalId ? String(settings.goalId) : ''
  return JSON.stringify({ a: accs, g: goal, t: tgts, k: kws })
}

/**
 * Найти активную задачу с той же подписью (дубль). Чистая функция.
 *
 * Модуль в подпись НЕ входит: вызывающий передаёт задачи одного модуля
 * (стор пер-модульный, `getModuleStore(moduleKey)`). Если понадобится искать
 * по всем модулям сразу — сначала добавьте moduleKey в `taskSignature`.
 *
 * @param {Array<{status?: string, settings?: object, id?: string}>} tasks
 * @param {object} settings
 * @returns {object|null}
 */
export function findDuplicateActiveTask(tasks, settings) {
  const sig = taskSignature(settings)
  return (Array.isArray(tasks) ? tasks : []).find(
    (t) => ACTIVE_TASK_STATUSES.has(t?.status) && taskSignature(t?.settings || {}) === sig,
  ) || null
}
