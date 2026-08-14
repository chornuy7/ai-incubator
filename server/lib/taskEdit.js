/**
 * §9.8: правка уже созданной задачи.
 *
 * Решение звонка 12.08 (пересмотр правила от 21.07): править можно ВСЁ, что не бежит
 * прямо сейчас — паузу, остановленную, завершённую и упавшую. Заказчик прямым текстом:
 * «почему я не могу редактировать задачу, которая у меня остановлена?». Логика та же,
 * что была: запрет нужен только у ЖИВОГО воркера, иначе часть аккаунтов отработает по
 * старым настройкам, часть по новым, и результат не объяснить. У остановленной задачи
 * воркера нет — править безопасно, а перезапуск подхватит новые настройки.
 *
 * Чистые функции: тестируются без сети и без Telegram.
 */

/** Статусы, в которых правка разрешена (воркер не живой). */
export const EDITABLE_STATUSES = ['paused', 'stopped', 'done', 'error']
/** @deprecated оставлено для совместимости старых импортов. */
export const EDITABLE_STATUS = 'paused'

/**
 * Поля настроек, которые разрешено менять.
 *
 * `accountIds` теперь ВХОДИТ (звонок 12.08: «нужно управление аккаунтами внутри задачи,
 * плюс-минус по аккаунтам»). Смена состава требует переоформления локов — это делает
 * роут: снимает блокировки задачи и берёт их заново на новый состав. Без этого локи
 * остались бы на выбывших аккаунтах, а новые работали бы без защиты от второй задачи.
 */
export const EDITABLE_TASK_FIELDS = [
  'accountIds',
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
  if (EDITABLE_STATUSES.includes(status)) return { ok: true }
  if (status === 'running' || status === 'queued') {
    return { ok: false, reason: 'Задача выполняется — часть аккаунтов уже отработала по текущим настройкам. Поставьте на паузу или остановите, тогда настройки станут доступны.' }
  }
  return { ok: false, reason: `Неизвестный статус задачи (${status}) — правка недоступна.` }
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
