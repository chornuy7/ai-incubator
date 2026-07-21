/**
 * §9.8: правка уже созданной задачи. Решение заказчика от 21.07 — править можно
 * ТОЛЬКО на паузе.
 *
 * Почему не на лету: воркер живёт в памяти процесса и к моменту правки мог пройти
 * половину аккаунтов. Смена настроек на ходу даёт результат, где часть аккаунтов
 * отработала по старым настройкам, часть по новым, и объяснить его уже нельзя.
 * На паузе воркер вышел, настройки никто не читает — правка безопасна.
 *
 * Чистые функции: тестируются без сети и без Telegram.
 */

/** Правка разрешена только в этом статусе. */
export const EDITABLE_STATUS = 'paused'

/**
 * Поля настроек, которые разрешено менять.
 *
 * `accountIds` СОЗНАТЕЛЬНО не входит: за задачей держатся локи аккаунтов, и подмена
 * состава оставила бы локи на аккаунтах, которых в задаче уже нет, а новые — без
 * локов. Менять исполнителей = остановить и создать задачу заново.
 */
export const EDITABLE_TASK_FIELDS = [
  'targets', 'channels', 'promptText',
  'maxActions', 'minActions', 'maxPerAccount', 'minPerAccount',
  'delays', 'protectionLevel', 'delayPreset',
]

/**
 * Можно ли править задачу в таком статусе.
 * @param {string} status
 * @returns {{ok: boolean, reason?: string}}
 */
export function canEditTask(status) {
  if (status === EDITABLE_STATUS) return { ok: true }
  if (status === 'running' || status === 'queued') {
    return { ok: false, reason: 'Задачу можно править только на паузе: сейчас она выполняется, и часть аккаунтов уже отработала по текущим настройкам. Поставьте на паузу — настройки станут доступны.' }
  }
  return { ok: false, reason: `Задача завершена (${status}) — править нечего. Перезапустите её или создайте новую.` }
}

/**
 * Отобрать из патча только разрешённые поля. Чистая функция.
 * @param {object} patch
 * @returns {{settings: object, rejected: string[]}} rejected — что пришло, но менять нельзя
 */
export function pickEditableSettings(patch = {}) {
  /** @type {Record<string, unknown>} */
  const settings = {}
  const rejected = []
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue
    if (EDITABLE_TASK_FIELDS.includes(k)) settings[k] = v
    else rejected.push(k)
  }
  return { settings, rejected }
}
