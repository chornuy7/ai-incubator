import { createTaskStore } from '../lib/taskStore.js'
import { WORKERS, startWorker, stopWorker, pauseWorker } from './workers.js'
import { tryAcquireLocks, releaseTaskLocks } from '../lib/accountLocks.js'
import { releaseTaskBusy } from '../lib/accountBusy.js'
import { preflightAndLog } from '../lib/preflight.js'
import { resolveTotalTarget } from '../lib/targets.js'
import { getGoal, isGoalExpired } from '../goals.js'

/**
 * Просрочена ли цель/дедлайн задачи — та же проверка, что делает воркер в цикле (§9.4).
 * Нужна ДО запуска: иначе resume переведёт задачу в running, воркер тут же увидит
 * просрочку и вернёт её в stopped — со стороны это «возобновление не доходит».
 */
async function taskGoalExpired(settings) {
  if (settings?.deadline) return isGoalExpired({ deadline: settings.deadline })
  if (!settings?.goalId) return false
  try { const g = await getGoal(settings.goalId); return !!g && isGoalExpired(g) } catch { return false }
}

/** @type {Record<string, ReturnType<typeof createTaskStore>>} */
const stores = {}

/** @type {Record<string, { idPrefix: string, requiresTargets?: boolean, targetLabel?: string, targetLabelEn?: string, initProgress?: (s: object) => object }>} */
export const MODULE_DEFS = {
  mailing: { idPrefix: 'mail', requiresTargets: true, targetLabel: 'номер', targetLabelEn: 'phone number' },
  autoposting: { idPrefix: 'ap', requiresTargets: true, targetLabel: 'канал', targetLabelEn: 'channel' },
  'neuro-commenting': { idPrefix: 'nc', requiresTargets: true, targetLabel: 'канал', targetLabelEn: 'channel' },
  'neuro-chatting': { idPrefix: 'nch', requiresTargets: true, targetLabel: 'группу', targetLabelEn: 'group' },
  'mass-react': { idPrefix: 'mr', requiresTargets: true, targetLabel: 'цель', targetLabelEn: 'target' },
  'mass-looking': { idPrefix: 'ml', requiresTargets: true, targetLabel: 'юзера/канал', targetLabelEn: 'user or channel' },
  warming: { idPrefix: 'wm', requiresTargets: false },
  'neuro-dialogs': { idPrefix: 'nd', requiresTargets: false },
  ggr: { idPrefix: 'ggr', requiresTargets: false },
  parsing: { idPrefix: 'pr', requiresTargets: false },
  'parsing-groups': { idPrefix: 'pg', requiresTargets: false },
  'parsing-users': { idPrefix: 'pu', requiresTargets: true, targetLabel: 'группу', targetLabelEn: 'group' },
  'parsing-messages': { idPrefix: 'pm', requiresTargets: true, targetLabel: 'канал', targetLabelEn: 'channel' },
  'parsing-comments': { idPrefix: 'pc', requiresTargets: true, targetLabel: 'канал', targetLabelEn: 'channel' },
  // Сервисная задача (не кампанийный модуль): снятие спамблока через @SpamBot.
  'spam-unblock': { idPrefix: 'sub', requiresTargets: false },
}

export function getModuleStore(moduleKey) {
  if (!MODULE_DEFS[moduleKey]) return null
  if (!stores[moduleKey]) stores[moduleKey] = createTaskStore(moduleKey, MODULE_DEFS[moduleKey].idPrefix)
  return stores[moduleKey]
}

export function getWorker(moduleKey) {
  return WORKERS[moduleKey] ?? null
}

/** min<=max проверка для пары полей (feature 4). */
function checkMinMax(settings, minKey, maxKey, label, labelEn) {
  const min = Number(settings?.[minKey] ?? 0) || 0
  const max = Number(settings?.[maxKey] ?? 0) || 0
  if (min && max && min > max) {
    return {
      code: 'minGreaterThanMax',
      message: `Минимум больше максимума: ${label}`,
      messageEn: `Minimum is greater than maximum: ${labelEn} (${minKey} = ${min}, ${maxKey} = ${max}).`,
      params: { minKey, maxKey, min, max },
    }
  }
  return null
}

/**
 * Проверка запуска, отдающая СТРУКТУРУ, а не строку.
 *
 * Зачем два вида одного текста. Эта функция обслуживает и русский интерфейс, и MCP, а по
 * правилу раздела всё, что уезжает «мозгам», должно быть по-английски. Переводить
 * сообщение на английский нельзя — его читает оператор в панели; оставить русским тоже
 * нельзя — оно доезжало до оркестратора в `validate_task` как `code: 'launchRule'` и было
 * единственной кириллицей во всём протоколе.
 *
 * Поэтому логика ОДНА, а рендеров два: `message` для панели, `messageEn` для MCP.
 * Строковая обёртка `validateSettings` ниже сохранена — ей пользуется весь остальной код.
 *
 * @returns {{code: string, message: string, messageEn: string, params?: object}|null}
 */
export function validateSettingsDetailed(moduleKey, settings) {
  const def = MODULE_DEFS[moduleKey]
  if (!def) {
    return { code: 'unknownModule', message: 'Неизвестный модуль', messageEn: `Unknown module "${moduleKey}".` }
  }
  if (!settings?.accountIds?.length) {
    return {
      code: 'noAccounts',
      message: 'Выберите хотя бы один аккаунт',
      messageEn: 'Select at least one account: accountIds must not be empty.',
    }
  }
  const tgs = settings?.targets || settings?.channels || []
  if (def.requiresTargets && !tgs.length) {
    if (moduleKey === 'mass-react' && settings?.postUrls?.length) { /* посты вместо групп */ }
    else {
      return {
        code: 'noTargets',
        message: `Добавьте хотя бы одну ${def.targetLabel || 'цель'}`,
        messageEn: `Add at least one ${def.targetLabelEn || 'target'}: the module cannot run without targets.`,
      }
    }
  }
  // feature 4: min <= max для всех парных лимитов
  return (
    checkMinMax(settings, 'minActions', 'maxActions', 'действия', 'actions') ||
    checkMinMax(settings, 'minComments', 'maxComments', 'комментарии', 'comments') ||
    checkMinMax(settings, 'minPerAccount', 'maxPerAccount', 'на аккаунт', 'per account') ||
    null
  )
}

/** Строковая форма для интерфейса и остального кода. Русская — её читает человек. */
export function validateSettings(moduleKey, settings) {
  return validateSettingsDetailed(moduleKey, settings)?.message ?? null
}

/**
 * @param {string} moduleKey
 * @param {object} settings
 * @param {{lang?: 'ru'|'en'}} [opts] `lang: 'en'` — тексты отказов по-английски.
 *   Нужен MCP: по правилу раздела всё, что уезжает «мозгам», пишется по-английски.
 *   Умолчание русское и не менялось — его читает оператор в панели.
 */
export function startModuleTask(moduleKey, settings, opts = {}) {
  const en = opts.lang === 'en'
  const store = getModuleStore(moduleKey)
  const worker = getWorker(moduleKey)
  if (!store || !worker) throw new Error(en ? `Module "${moduleKey}" is not supported.` : 'Модуль не поддерживается')

  const err = validateSettingsDetailed(moduleKey, settings)
  if (err) throw new Error(en ? err.messageEn : err.message)

  if (moduleKey === 'mass-looking') {
    settings.lookMode = ['stories', 'posts', 'both'].includes(settings.lookMode) ? settings.lookMode : 'stories'
    if (settings.lookMode !== 'stories') {
      settings.lookPostsCount = Math.min(Math.max(Math.trunc(Number(settings.lookPostsCount) || 0) || 3, 1), 50)
    }
  }

  const max = settings.maxActions ?? settings.maxComments ?? 100
  const task = store.createTask(settings, {
    progress: { done: 0, total: max, actionsDone: 0, commentsSent: 0 },
    results: [],
    commentHistory: [],
  })
  // Прогресс считаем от РЕАЛЬНОЙ цели, а не от максимума диапазона.
  //
  // Цель выбирается случайно в [min, max] и детерминирована по id задачи (§4: чтобы
  // аккаунты не работали одинаково). Воркер останавливается по ней, а в прогресс писался
  // максимум — поэтому задача с целью 9 при maxActions=10 доходила до конца и вставала
  // как «Готово» на 9/10 = 90%. Теперь знаменатель — та же цель, по которой воркер решает
  // «хватит»: 9/9 = 100%. Для режима «по времени» счётчик действий не показателен —
  // там оставляем максимум как есть.
  try {
    const byDuration = settings.workMode === 1 && settings.durationMinutes
    if (!byDuration) {
      const target = resolveTotalTarget(settings, task)
      if (target > 0) task.progress.total = target
    }
  } catch { /* не смогли уточнить — остаётся максимум, как было */ }
  // goalId нужен локам: мейлинг и чатинг под ОДНОЙ целью делят аккаунты (§9).
  const lockErr = tryAcquireLocks(settings.accountIds, moduleKey, task.id, { goalId: settings.goalId, lang: opts.lang })
  if (lockErr) throw new Error(lockErr)
  return { store, task, worker }
}

/**
 * §4.4: предупредить о кластере по прокси на старте задачи.
 *
 * Проверка была написана и оттестирована, но её никто не вызывал — а именно так
 * Telegram и находит группу: пачка аккаунтов выходит с одного IP в одну минуту,
 * банят одного, следом добивают похожих. Ошибкой это не считаем: прокси бывает
 * один на всех осознанно, и запрет остановил бы работу. Оператор должен ВИДЕТЬ
 * риск в логе задачи, а решение — за ним.
 */
async function warnAboutProxyCluster(task, store, accountIds) {
  try {
    const [{ proxySpreadGate }, { getAccountMeta }] = await Promise.all([
      import('../lib/antiCluster.js'),
      import('../accountsMeta.js'),
    ])
    const byAccount = {}
    for (const id of accountIds) {
      const meta = await getAccountMeta(id)
      byAccount[id] = meta?.proxy || ''
    }
    const gate = proxySpreadGate(byAccount, accountIds)
    if (!gate.ok) await store.appendLog(task, 'warning', `Риск кластера (§4.4): ${gate.reason}`)
  } catch { /* предупреждение не должно мешать запуску задачи */ }
}

export async function launchTask(moduleKey, task, store) {
  const worker = getWorker(moduleKey)
  if (!worker) return
  await store.saveTask(task)
  const ids = task.settings?.accountIds || []
  if (ids.length > 1) await warnAboutProxyCluster(task, store, ids)
  // Предстартовая проверка: у кого нет сессии/прокси — сразу видно в логе, а не через
  // час холостых RPC-таймаутов. Если ехать некому — не запускаем воркер вовсе.
  if (!(await gateOnPreflight(task, store))) return
  startWorker(task.id, store, worker)
}

/**
 * Пускать ли задачу: проверяем аккаунты и пишем причины в лог. Ни одного пригодного —
 * останавливаем сразу с понятным текстом (раньше такая задача часами «выполнялась»,
 * не сделав ни одного действия). @returns {Promise<boolean>}
 */
async function gateOnPreflight(task, store) {
  const ids = task.settings?.accountIds || []
  if (!ids.length) return true // модули без аккаунтов (парсер по ссылке) — не наше дело
  const { ready, problems } = await preflightAndLog(task, store)
  if (ready.length) return true
  task.status = 'stopped'
  task.stopRequested = true
  const why = problems.map((p) => `${p.name} — ${p.reason}`).join('; ')
  await store.appendLog(task, 'error', `Запуск отменён: ни один аккаунт не готов. ${why}`)
  await store.saveTask(task, { control: true })
  try { releaseTaskLocks(task.id) } catch { /* локов могло не быть */ }
  try { releaseTaskBusy(task.id) } catch { /* слотов могло не быть */ }
  return false
}

export async function stopModuleTask(moduleKey, taskId) {
  const store = getModuleStore(moduleKey)
  if (!store) return null
  return stopWorker(taskId, store)
}

/** Пауза задачи (§3.9): воркер выйдет, статус станет «paused», прогресс сохранён. */
export async function pauseModuleTask(moduleKey, taskId) {
  const store = getModuleStore(moduleKey)
  if (!store) return null
  return pauseWorker(taskId, store)
}

/**
 * Продолжить задачу С ТОГО ЖЕ МЕСТА: перезахват локов + запуск воркера с сохранённым
 * прогрессом. Работает и для `paused`, и для `stopped` — прогресс (actionsDone) стоп не
 * обнуляет, а аккаунты стоп освободил, поэтому локи берём заново. Так «Возобновить»
 * остановленной задачи продолжает ту же, а не плодит новую с нуля (это делает restart).
 */
export async function resumeModuleTask(moduleKey, taskId) {
  const store = getModuleStore(moduleKey)
  if (!store) return null
  const task = await store.loadTask(taskId)
  if (!task) return null
  if (task.status !== 'paused' && task.status !== 'stopped') return task
  const wasStopped = task.status === 'stopped'
  // Pre-flight: если цель просрочена — воркер сразу же остановит задачу. Не переводим её
  // в running зря (мигание running→stopped), а честно отвечаем причиной.
  if (await taskGoalExpired(task.settings)) {
    throw new Error('Цель просрочена — возобновить нельзя. Продлите дедлайн кампании или запустите новую задачу.')
  }
  const lockErr = tryAcquireLocks(task.settings?.accountIds || [], moduleKey, task.id, { goalId: task.settings?.goalId })
  if (lockErr) throw new Error(lockErr)
  task.pauseRequested = false
  task.stopRequested = false
  task.status = 'running'
  // ВАЖЕН ПОРЯДОК: сначала control-сейв сбрасывает stop/pause на диске, и только потом
  // appendLog. appendLog внутри делает обычный (не control) saveTask, а тот перечитывает
  // stopRequested с диска — если лог идёт ДО control-сейва, он вернёт старый stopRequested=true
  // и возобновлённая задача стартует «уже остановленной» (воркер выходит мгновенно, 0 действий).
  await store.saveTask(task, { control: true })
  await store.appendLog(task, 'info', wasStopped
    ? 'Возобновлена с места остановки — прогресс сохранён, аккаунты захвачены заново'
    : 'Возобновлена с паузы')
  // Та же проверка, что и при первом запуске: повторный запуск на мёртвых прокси —
  // это ровно тот случай, когда задача часами «выполняется» вхолостую.
  if (!(await gateOnPreflight(task, store))) return task
  startWorker(task.id, store, getWorker(moduleKey))
  return task
}

export function listModuleKeys() {
  return Object.keys(MODULE_DEFS)
}
