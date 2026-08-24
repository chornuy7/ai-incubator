import { runSpamUnblock } from '../spamUnblock.js'
import { generateComment, isAiGenerationEnabled, resolveSystemPrompt } from '../neuroCommenting/commentGenerator.js'
import { buildGoalContext, stageForStatus, linksFromGoal, cleanDialogReply, hasPlaceholder } from '../lib/goalContext.js'
import { upsertMany } from '../channels.js'
import {
  fetchPosts,
  sendChannelComment,
  sendReaction,
  searchPublic,
  searchPublicDetailed,
  getChannelMembersCount,
  fetchParticipants,
  fetchDialogs,
  readUserHistory,
  markStoriesRead,
  viewRecentPosts,
  joinDiscussionGroupIfNeeded,
  diagnoseWriteBan,
  mapTelegramError,
} from '../lib/gramHelpers.js'
import { joinTargetOrSkip, joinChannelDiscussion, prepareTarget } from '../lib/joinTarget.js'
import {
  connectAccount,
  disconnectAccount,
  handleFlood,
  perAccountLimitReached,
  totalLimitReached,
  abortTaskClients,
  applySpamblockPolicy,
} from '../lib/accountRunner.js'
import { accountFingerprint } from '../lib/deviceFingerprint.js'
import {
  delayMultiplier,
  pickDelay,
  pickJoinDelay,
  effectiveProbability,
  canReplyWithStatus,
  isAccountReplyOnly,
  postMeetsMinWords,
  postMatchesKeywords,
  sleep,
  interruptibleSleep,
} from '../lib/protection.js'

/**
 * Синхронный флаг «пора остановиться» — для ожиданий, где async-проверка не годится
 * (ожидание слота занятости внутри connectAccount). Читает живой объект задачи: именно
 * на нём stopWorker/pauseWorker ставят флаг, не дожидаясь записи на диск.
 */
const stopFlag = (task) => () => !!(task?.stopRequested || task?.pauseRequested)

/** #6: колбэк «пора остановиться?» — читает stop/pause с диска (свежий флаг). */
function makeStopCheck(store, taskId) {
  return async () => { try { const t = await store.loadTask(taskId); return !!(t?.stopRequested || t?.pauseRequested) } catch { return false } }
}

/** Длительность по-человечески: «47 с», «3 мин», «1 ч 12 мин». */
export function fmtWait(ms) {
  const sec = Math.round(ms / 1000)
  if (sec < 90) return `${sec} с`
  const min = Math.round(sec / 60)
  if (min < 90) return `${min} мин`
  return `${Math.floor(min / 60)} ч ${min % 60} мин`
}

/**
 * Учесть и показать паузу (правка 20.08 по просьбе владельца: «все задержки выводим в
 * лог и суммируем»).
 *
 * До этого в логе были видны только три вида ожиданий — вступление в канал, простой из-за
 * усталости и разбег стартов парсера. Основные паузы между действиями (десятки секунд, а
 * на консервативном пресете и минуты) не оставляли следа: со стороны задача выглядела
 * зависшей, и объяснить оператору, почему за час сделано пять комментариев, было нечем.
 *
 * Сумма копится в `task.progress.waitMs` — по ней видно, сколько задача реально ПРОСТОЯЛА,
 * в отличие от прогнозного ETA в дашборде.
 * @param {object} task @param {object} store @param {number} ms @param {string} reason
 * @param {string} [accountName]
 */
export async function noteWait(task, store, ms, reason, accountName) {
  if (!(ms > 0)) return
  task.progress = task.progress || {}
  task.progress.waitMs = (Number(task.progress.waitMs) || 0) + ms
  await store.appendLog(task, 'info', `Пауза ${fmtWait(ms)} — ${reason}`, accountName)
}

/**
 * MR-130: прерываемая пауза МЕЖДУ действиями. Раньше основные задержки были обычным
 * `sleep(...)` — при высоком уровне защиты это десятки секунд/минуты, и «Стоп» всё это
 * время игнорировался (задача «в воздухе»). Здесь спим кусками по 1с, читая стоп/паузу
 * СВЕЖИМИ с диска (независимо от in-memory-копии воркера). Если снаружи пришёл стоп/пауза —
 * переносим флаги в `task`, чтобы финальный статус был `stopped`/`paused`, а не `done`,
 * и возвращаем true → вызывающий делает `break`. @returns {Promise<boolean>}
 */
export async function breakableDelay(ms, store, task) {
  if (!(await interruptibleSleep(ms, makeStopCheck(store, task.id)))) return false
  const fresh = await store.loadTask(task.id).catch(() => null)
  if (fresh) {
    task.stopRequested = task.stopRequested || fresh.stopRequested
    task.pauseRequested = task.pauseRequested || fresh.pauseRequested
  }
  return true
}
import { getAccountMeta, setAccountMeta, accountLabel } from '../accountsMeta.js'
import { releaseTaskLocks, markTaskLive, markTaskDone, assertAccountAvailable } from '../lib/accountLocks.js'
import { loadSessionString, createClient } from '../tgAuth.js'
import {
  pickCommentCandidates, trackIdlePass, warmingPace, pickWeightedKey, idleWaitPlan, WARM_WINDOW_MS, msUntilHour, inActiveWindow,
} from '../lib/workerLoop.js'
import { scheduleHour } from '../lib/accountFatigue.js'
import { limitReached, incAction } from '../lib/dailyActions.js'
import { cleanMailingNumbers, classifyMailingTargets, pickMailingAccount } from '../lib/mailing.js'
import { listLeads, sortDialogsByLeadPriority, upsertLead, updateLead } from '../leads.js'
import { classifyLeadReply, shouldAdvance } from '../lib/leadClassifier.js'
import { chargeActions, chargeCollected, refundShrunk } from '../lib/actionBilling.js'
import { serializeHits, restoreHits, keepIntersecting } from '../lib/parserIntersect.js'
import { isSemanticEnabled, embedText, cosineSimilarity } from '../lib/semantic.js'
import { parseTelegramPostLinks, resolvePostPeer } from '../lib/postLink.js'
import { findChannelChat, isChannelPeer } from '../lib/channelChat.js'
import { followUpDecision, followUpPrompt, followUpStatus } from '../lib/followUp.js'
import { buildAgentContext, getAgent } from '../agents.js'
import { recordTokens } from '../tokenLedger.js'
import { recordMessage } from '../messages.js'
import { recordAction } from '../actionLog.js'
import { describeIncomingImage, messageHasPhoto } from '../lib/visionDescribe.js'
import { effectivePrices } from '../priceStore.js'
import { canWorkNow, noteAction } from '../accountActivity.js'
import { typingPlan, describeTyping, fmtDelay, monitorPoll } from '../lib/humanDelays.js'
import { beginAccountWork, endAccountWork, releaseTaskBusy } from '../lib/accountBusy.js'
// Гейт статуса ЗАВИСИТ ОТ МОДУЛЯ: пока аккаунт греется, боевые модули его не берут, а
// прогрев — берёт. Раньше эту границу держал общий лок «один аккаунт = одна задача»;
// многомодульность (20.08) его сняла, и `isAccountRunnable` (в его SKIP_STATUSES нет
// `warming`) начал пускать греющийся профиль в мейлинг — прямой путь к спамблоку.
import { canModuleUseAccount } from '../lib/accountStatus.js'
import { getGoal, isGoalExpired } from '../goals.js'

/**
 * §9.4: цель просрочена — работа по ней ОСТАНАВЛИВАЕТСЯ. Раньше дедлайн проверялся
 * только при СОЗДАНИИ задачи: запущенная накануне рассылка спокойно продолжала
 * работать и после срока, то есть обещание «дедлайн останавливает работу» держалось
 * лишь до первого запуска. Проверяем в цикле воркера, дёшево и по месту.
 * @param {object} settings @returns {Promise<boolean>}
 */
async function goalExpired(settings) {
  // Дедлайн переехал из цели в кампанию (24.07) и приезжает в настройках задачи.
  // Цель проверяем следом — только ради кампаний, заведённых до переезда.
  if (settings?.deadline) return isGoalExpired({ deadline: settings.deadline })
  if (!settings?.goalId) return false
  try {
    const goal = await getGoal(settings.goalId)
    return !!goal && isGoalExpired(goal)
  } catch { return false } // сбой чтения цели не должен останавливать работу
}
import { filterBlacklisted, isBlacklistedSync, isBlacklistedMailingTarget } from '../targetBlacklist.js'
import { pickReactionPost, normalizeLastPostsCount } from '../lib/reactionPick.js'

/** @type {Map<string, Promise<void>>} */
const running = new Map()
/**
 * Живые in-memory объекты задач работающих воркеров (taskId → task).
 *
 * stopWorker/pauseWorker грузят СВОЮ копию задачи с диска и ставят флаг на ней — но
 * воркер крутит цикл над ДРУГИМ объектом и подхватывал флаг только когда сам перечитает
 * диск (в breakableDelay). Между действиями (во время реального действия в TG) стоп
 * игнорировался — «остановлена, а крутится». Держим ссылку на живой объект и ставим
 * флаг прямо на нём → ближайший `if (task.stopRequested) break` срабатывает мгновенно.
 * @type {Map<string, object>}
 */
const liveTasks = new Map()

/** Мгновенно донести стоп/паузу до работающего воркера (не дожидаясь перечитки диска). */
function signalLiveTask(taskId, { stop, pause } = {}) {
  const live = liveTasks.get(taskId)
  if (!live) return false
  if (stop) live.stopRequested = true
  if (pause) live.pauseRequested = true
  return true
}
/**
 * MR-130 (§3.9 «секвенс»): очередь задач, ждущих свободный слот. Раньше startWorker
 * запускал КАЖДУЮ задачу сразу — десятки воркеров уходили в фон «в воздух», грузили
 * CPU/сеть и путали оператора. Теперь одновременно работает не больше MAX_CONCURRENT,
 * остальные висят здесь в статусе `queued` и стартуют по мере освобождения слотов.
 * @type {Array<{ taskId: string, store: object, runner: Function }>}
 */
const waiting = []
/**
 * Сколько задач выполняется ОДНОВРЕМЕННО. MR-144: значение стало настраиваемым (панель
 * владельца → settings.maxParallelTasks). Стартовое — из env, дальше его переопределяет
 * setMaxConcurrent() при загрузке настроек и при их изменении через API. Держим `let`,
 * а не const, и читаем через переменную во всех местах гейта очереди.
 */
let MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_TASKS) || 3)

/** MR-144: применить новый лимит параллельных задач. Если слотов стало больше — сразу
 *  дотягиваем очередь (pumpWaiting), чтобы ждущие задачи не висели до следующего события. */
export function setMaxConcurrent(n) {
  const v = Math.max(1, Math.min(20, Math.round(Number(n)) || MAX_CONCURRENT))
  if (v === MAX_CONCURRENT) return MAX_CONCURRENT
  MAX_CONCURRENT = v
  pumpWaiting()
  return MAX_CONCURRENT
}

/** Для тестов/диагностики и дашборда: сколько сейчас работает, сколько ждёт и лимит. */
export function getConcurrencyState() {
  return { running: running.size, waiting: waiting.length, max: MAX_CONCURRENT }
}

/** Снять задачу из очереди ожидания (стоп/пауза до старта). @returns {boolean} была ли в очереди */
function dropFromWaiting(taskId) {
  const i = waiting.findIndex((w) => w.taskId === taskId)
  if (i === -1) return false
  waiting.splice(i, 1)
  return true
}

/** Пометить ждущую задачу как «в очереди» — чтобы она была видна, а не «пропала». */
async function markQueued(taskId, store) {
  try {
    const task = await store.loadTask(taskId)
    if (!task || task.status === 'stopped' || task.stopRequested || task.pauseRequested) return
    task.status = 'queued'
    await store.appendLog(task, 'info', `В очереди — ждём свободный слот (одновременно не больше ${MAX_CONCURRENT})`)
    await store.saveTask(task)
  } catch { /* учёт очереди не должен ронять запуск */ }
}

/** @param {string} taskId @param {object} store @param {(task: object, store: object) => Promise<void>} runner */
export function startWorker(taskId, store, runner) {
  if (running.has(taskId) || waiting.some((w) => w.taskId === taskId)) return
  // Лок задача взяла ещё на POST — держим её «живой» и в очереди, иначе reconcileLocks
  // счёл бы её локи бесхозными и отдал аккаунты другим, пока она ждёт слот.
  markTaskLive(taskId)
  if (running.size >= MAX_CONCURRENT) {
    waiting.push({ taskId, store, runner })
    void markQueued(taskId, store)
    return
  }
  launchWorker(taskId, store, runner)
}

function launchWorker(taskId, store, runner) {
  markTaskLive(taskId)
  const job = (async () => {
    const task = await store.loadTask(taskId)
    if (!task) return
    // Регистрируем живой объект: stopWorker/pauseWorker поставят флаг прямо на нём,
    // и воркер увидит стоп на ближайшем шаге, не дожидаясь перечитки диска.
    liveTasks.set(taskId, task)
    try {
      await runner(task, store)
    } finally {
      // Страховка: любой терминальный путь воркера (в т.ч. ранний return,
      // исключение до finalizeAccounts) обязан снять блокировки и сбросить статусы.
      //
      // Флаг паузы обязателен: без него эта страховка ОТМЕНЯЛА решение воркера. Воркер
      // на выходе честно звал finalizeAccounts(..., pauseRequested) и локи держал, а
      // строкой ниже они снимались снова — уже без флага. В итоге ветка «пауза
      // резервирует аккаунты» была мертва: поставили мейлинг на паузу, коллега занял те
      // же аккаунты вторым мейлингом, «Возобновить» падало с «аккаунты заняты» (аудит 20.08).
      // Диск и живой объект проверяем ОБА: паузу могли выставить и снаружи (в задаче на
      // диске), и на живом объекте через signalLiveTask — раннер его переприсваивает.
      const fresh = await store.loadTask(taskId).catch(() => null)
      const paused = !!(fresh?.pauseRequested || fresh?.status === 'paused' || task.pauseRequested)
      await finalizeAccounts(task.settings?.accountIds || [], taskId, paused)
    }
  })().finally(() => {
    running.delete(taskId)
    liveTasks.delete(taskId)
    markTaskDone(taskId)
    pumpWaiting()
  })
  running.set(taskId, job)
}

/** Освободился слот — запускаем следующую ждущую задачу (если её не сняли из очереди). */
function pumpWaiting() {
  while (running.size < MAX_CONCURRENT && waiting.length) {
    const next = waiting.shift()
    if (running.has(next.taskId)) continue
    launchWorker(next.taskId, next.store, next.runner)
  }
}

/**
 * Стоп задачи. Для РАБОТАЮЩЕЙ — выставляем флаг, воркер выйдет из цикла сам.
 *
 * Для задачи НА ПАУЗЕ живого воркера нет, и флаг обрабатывать некому: раньше стоп
 * возвращал 200, а задача так и оставалась `paused` — оператор видел успех, но её
 * можно было «возобновить» кнопкой, то есть «остановленная» боевая задача оживала
 * (прогон 21–22.07, тест 6.2). Поэтому здесь останавливаем сами: ставим статус,
 * снимаем локи и освобождаем аккаунты — ровно то, что сделал бы воркер на выходе.
 * @param {string} taskId @param {object} store
 */
export async function stopWorker(taskId, store) {
  const task = await store.loadTask(taskId)
  if (!task) return null
  task.stopRequested = true
  // Мгновенно доносим стоп до работающего воркера (его in-memory объект), иначе он
  // увидел бы флаг только на следующей перечитке диска — «остановлена, а крутится».
  signalLiveTask(taskId, { stop: true })
  // Принудительно рвём соединения задачи: если воркер завис в сетевом gram-вызове
  // (медленный прокси, нет таймаута), обрыв заставит вызов упасть — и воркер выйдет
  // по стопу за секунды, а не спустя десятки секунд ожидания ответа.
  void abortTaskClients(taskId)
  // Задача НА ПАУЗЕ или В ОЧЕРЕДИ (ждёт слот) — живого воркера нет, флаг обработать
  // некому. Останавливаем сами: снимаем из очереди, ставим статус, освобождаем аккаунты.
  const wasWaiting = dropFromWaiting(taskId)
  if ((task.status === 'paused' || task.status === 'queued' || wasWaiting) && !running.has(taskId)) {
    task.pauseRequested = false
    task.status = 'stopped'
    await store.appendLog(task, 'info', wasWaiting || task.status === 'queued'
      ? 'Задача снята из очереди — остановлена, аккаунты освобождены'
      : 'Задача остановлена с паузы — аккаунты освобождены')
    await store.saveTask(task)
    await finalizeAccounts(task.settings?.accountIds || [], task.id, false)
    markTaskDone(taskId)
    return task
  }
  await store.saveTask(task)
  return task
}

/**
 * Пауза (§3.9): воркер выйдет из цикла как при стопе, но задача останется «paused»
 * (прогресс сохранён) — можно продолжить с /resume. @param {string} taskId @param {object} store
 */
export async function pauseWorker(taskId, store) {
  const task = await store.loadTask(taskId)
  if (!task) return null
  if (task.status !== 'running' && task.status !== 'queued') return task
  task.pauseRequested = true
  // Мгновенно доносим паузу до работающего воркера (см. signalLiveTask в stopWorker).
  signalLiveTask(taskId, { pause: true })
  // Рвём соединения задачи — зависший сетевой вызов упадёт, воркер быстро выйдет на паузу.
  void abortTaskClients(taskId)
  // Ждала слот и ещё не запускалась — ставим на паузу сами, без холостого запуска
  // воркера, который тут же вышел бы. Локи держим (пауза их сохраняет) → задача «живая».
  if (dropFromWaiting(taskId) && !running.has(taskId)) {
    task.status = 'paused'
    await store.appendLog(task, 'info', 'Задача снята из очереди — поставлена на паузу')
  }
  await store.saveTask(task)
  return task
}

/** Итоговый статус воркера: пауза важнее стопа, стоп важнее «готово». @param {object} task */
export function statusAfterRun(task) {
  // Фатальная ошибка старше флагов остановки. Задача, упавшая из-за мёртвого ключа ИИ,
  // не «остановлена оператором» и тем более не «готова»: в дашборде это ОШИБКА.
  // Живой прогон 18.08: ключ OpenAI отклонён, задача доработала до конца и показала
  // «Готово · 0/2» — по такому статусу человек считает, что всё в порядке.
  if (task.fatalError) return 'error'
  return task.pauseRequested ? 'paused' : task.stopRequested ? 'stopped' : 'done'
}

/**
 * Итоговая строка лога — по фактическому статусу, а не всегда «Завершено».
 * К ней добавляется суммарное ожидание: «сколько заняла задача» без «сколько из этого
 * она простояла» читается как медленная работа, хотя паузы и есть её работа.
 */
export function finishNote(task, doneText = 'Завершено') {
  const waited = Number(task.progress?.waitMs) || 0
  const tail = waited > 0 ? ` · в паузах ${fmtWait(waited)}` : ''
  if (task.status === 'error') return `Задача завершилась с ошибкой: ${task.fatalError || 'см. записи выше'}${tail}`
  if (task.status === 'paused') return `Пауза${tail}`
  if (task.status === 'stopped') return `Остановлено${tail}`
  return `${doneText}${tail}`
}

/**
 * Свалить задачу с фатальной ошибкой: залогировать, пометить и СРАЗУ сохранить.
 *
 * Сохранение здесь обязательно. Воркер в конце круга перечитывает задачу с диска
 * (`task = await store.loadTask(...)`), и невсохранённый `stopRequested` при этом
 * терялся: цикл продолжался как ни в чём не бывало. Именно так после сообщения
 * «Задача остановлена — комментарии без ИИ не публикуем» в логах появлялся ещё один
 * «Пропуск по вероятности» (прогон 18.08).
 *
 * @param {object} task @param {object} store @param {string} reason @param {string} [accountName]
 */
export async function failTask(task, store, reason, accountName) {
  await store.appendLog(task, 'error', reason, accountName)
  task.fatalError = reason
  task.stopRequested = true
  task.status = 'error'
  await store.saveTask(task)
}

async function finalizeAccounts(accountIds, taskId, paused = false) {
  // На паузе аккаунты остаются зарезервированными за задачей (лок держим) и переходят в статус
  // «pause» — чтобы в менеджере было видно, в каком модуле аккаунт на паузе. На стопе/финише — освобождаем.
  if (taskId && !paused) releaseTaskLocks(taskId)
  // Слот занятости снимаем ВСЕГДА, даже на паузе: лок — это «аккаунт закреплён за задачей»,
  // а занятость — «прямо сейчас идёт действие». Пауза действие прекращает, и держать слот
  // не за чем. Без этой строки любой выход мимо disconnectAccount (падение промиса, стоп
  // посреди задержки) выключал аккаунт из ВСЕХ модулей до перезапуска процесса — аудит 20.08.
  if (taskId) releaseTaskBusy(taskId)
  for (const id of accountIds) {
    const meta = await accountMeta(id)
    if (meta.status === 'working') await setAccountMeta(id, { status: paused ? 'pause' : 'active' })
  }
}

/**
 * Мета аккаунта с гарантированной подписью: половина пула импортирована без имени,
 * и лог выходил безымянным (прогон 22.08). Логи ниже читают `meta.name` в 140+ местах —
 * подставляем запасную подпись один раз здесь, в хранилище её не пишем.
 */
async function accountMeta(id) {
  const meta = await getAccountMeta(id)
  meta.name = accountLabel(meta, id)
  return meta
}

function targets(settings) {
  const list = (settings.targets || settings.channels || []).map((t) => t.replace(/^@/, '').trim()).filter(Boolean)
  // feature 10: исключаем цели из чёрного списка перед любыми действиями
  return filterBlacklisted(list)
}

async function bumpProgress(task, store) {
  task.progress.actionsDone = (task.progress.actionsDone || 0) + 1
  task.progress.done = task.progress.actionsDone
  if (task.progress.commentsSent !== undefined) task.progress.commentsSent = task.progress.actionsDone
  // ЖДЁМ списание: оно при нуле ставит task.pauseRequested, а saveTask ниже должен
  // сохранить уже выставленный флаг. Иначе цикл перезагрузит задачу с диска и
  // затрёт паузу — модуль сделал бы несколько лишних действий на нулевом балансе.
  await chargeActions(task, store, 1)
  // MR-130: стоп/пауза могли прийти извне между reload'ами — свой save НЕ должен их
  // затирать, иначе даже свежий makeStopCheck прочитает сброшенный флаг и «Стоп» потеряется.
  const fresh = await store.loadTask(task.id).catch(() => null)
  if (fresh?.stopRequested) task.stopRequested = true
  if (fresh?.pauseRequested) task.pauseRequested = true
  return store.saveTask(task)
}

/** @param {object} task @param {object} store */
/** §3.5: взвешенный выбор индекса типа комментария по распределению (сумма ≈ 100%). */
/**
 * Какой промпт взять на это действие и с каким системным текстом.
 *
 * Если задано распределение типов (`typeWeights`) — тип выбирается взвешенным броском на
 * КАЖДОЕ действие, иначе берётся один выбранный `promptIndex`. До 19.08 так умел только
 * нейрокомментинг: чаттинг, диалоги и мейлинг молча брали один и тот же тип, хотя набор
 * промптов у них такой же. Отсюда «шесть типов в интерфейсе, один тон в переписке».
 * @param {object} s настройки задачи
 * @param {string} [extra] контекст цели/агента, который добавляется к системному тексту
 */
function pickPrompt(s, weights, extra = '') {
  const useDist = Array.isArray(weights) && weights.some((w) => Number(w) > 0)
  const index = useDist ? weightedPickIndex(weights) : (s.promptIndex ?? 0)
  const sys = useDist
    ? resolveSystemPrompt({ ...s, promptIndex: index, promptText: '' })
    : resolveSystemPrompt(s)
  return { index, sys: sys + extra }
}

function weightedPickIndex(weights) {
  const total = weights.reduce((a, b) => a + (Number(b) || 0), 0)
  if (total <= 0) return 0
  let r = Math.random() * total
  for (let i = 0; i < weights.length; i++) { r -= Number(weights[i]) || 0; if (r < 0) return i }
  return weights.length - 1
}

export async function runNeuroCommenting(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  task.readyTargets = task.readyTargets || []
  task.actionKeys = task.actionKeys || []
  await store.saveTask(task)
  await store.appendLog(task, 'info', 'Нейрокомментинг запущен')

  // §3.6/§4: если задача привязана к цели — подмешиваем цель + базу знаний в системный промпт.
  const goalCtx = await buildGoalContext(s.goalId)
  // A3.3: тон, роль и запреты берём у АГЕНТА задачи, а не у цели (SPEC §1.2).
  // Пустая строка, если агент не выбран — генерация работает как раньше.
  const agentCtx = await buildAgentContext(s.agentId)
  // Дожим тоже принадлежит агенту: «дожимать или отпускать» — манера общения.
  // Для задач без агента остаётся цель — старые кампании продолжают работать.
  const agentObj = s.agentId ? await getAgent(s.agentId).catch(() => null) : null
  if (goalCtx) await store.appendLog(task, 'info', 'Комментарии генерируются к выбранной цели (с базой знаний)')

  // §3.5 семантика: если включён семантический фильтр и есть цель — считаем её вектор один раз.
  const semanticOn = !!s.semanticFilter && !!goalCtx && isSemanticEnabled()
  const semanticThreshold = Number(s.semanticThreshold ?? 0.2)
  let goalVec = null
  if (semanticOn) {
    goalVec = await embedText(goalCtx, task.userId)
    await store.appendLog(task, goalVec ? 'info' : 'warning', goalVec
      ? `Семантический фильтр к цели включён (порог ${semanticThreshold})`
      : 'Семантический фильтр недоступен (нет ответа embeddings) — работаем без него')
  }

  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const prob = effectiveProbability(s.probability ?? 30, !!s.aiProtection, s.protectionLevel ?? 1)
  // «Мониторинг новых» (postFilter = 4): верхняя планка постов на канал. Первый заход
  // её ставит и НЕ комментирует — иначе «только новые» означало бы комментарий к посту,
  // который вышел до запуска задачи. Живёт в памяти: после рестарта планка встаёт
  // заново, посты из времени простоя новыми не считаются (как в массовых реакциях).
  const seenTop = new Map()
  const chs = targets(s)
  let idx = 0
  // idleLap считает подряд пропущенные аккаунты. Полный круг пропусков = никто не может работать
  // (все выбрали лимит на аккаунт или недоступны), а общий лимit при малом числе аккаунтов может быть
  // недостижим — без этого while крутился бы вхолостую на 100% CPU. Тогда завершаем задачу.
  let idleLap = 0
  // Почему круг оказался пустым: без этого задача завершалась словами «исчерпали
  // лимиты» даже когда всех отсеял распорядок — и ноль действий читался как поломка.
  let lastSkip = ''
  // Ближайшее время, когда хоть один аккаунт снова сможет работать (0 — неизвестно).
  let idleUntil = 0
  const accountIds = s.accountIds || []

  try {
    while (!task.stopRequested && !task.pauseRequested && !totalLimitReached(s, task)) {
      // §9.4: дедлайн цели останавливает и УЖЕ ИДУЩУЮ работу, а не только новые запуски.
      if (await goalExpired(s)) {
        await store.appendLog(task, 'warning', 'Цель просрочена — работа по ней остановлена (§9.4)')
        task.stopRequested = true
        break
      }
      if (idleLap >= accountIds.length) {
        // Круг пустой: все аккаунты отпали. Причина бывает временной (отдых, распорядок)
        // и окончательной (лимиты, статус). Во временном случае ЖДЁМ ближайшее окно, а не
        // завершаем задачу: прогон 18.08 отдал 1 действие из 2, потому что аккаунту
        // оставалось отдыхать две минуты. Потолок ожидания — IDLE_WAIT_CAP_MS.
        const plan = idleWaitPlan(idleUntil)
        if (plan.wait) {
          // Причину берём из последнего пропуска: «отдых» — лишь одна из них, бывает
          // ещё распорядок и бросок кубика. Текст «заняты отдыхом» при пропуске по
          // вероятности прямо противоречил соседней строке лога (правка 19.08).
          // Во сколько вернётся ближайший аккаунт — это первое, что спрашивают, глядя
          // на «ждём N мин» (правка 19.08). Задача при этом остаётся в работе.
          const backAt = new Date(idleUntil).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          // Секунды, а не «1 мин»: почти все задержки здесь секундные (переключение
          // модулей, повтор броска), и округление вверх превращало 7 секунд в минуту.
          // Ждём РОВНО до окна — к следующей попытке аккаунт уже готов, а не «попробуем
          // ещё раз и посмотрим». Пауза идёт в общий счёт ожидания задачи.
          await noteWait(task, store, plan.ms, lastSkip
            ? `ждём аккаунт до ${backAt} (${lastSkip})`
            : `ждём ближайший свободный аккаунт до ${backAt}`)
          if (await breakableDelay(plan.ms, store, task)) break
          task = (await store.loadTask(task.id)) || task
          idleLap = 0
          idleUntil = 0
          lastSkip = ''
          continue
        }
        // Почему круг оказался пустым. Без этой оговорки задача завершалась словами
        // «исчерпали лимиты» даже когда всех до одного отсеял распорядок — и оператор
        // читал нулевой результат как поломку продукта (живой прогон 23.07).
        await store.appendLog(task, 'info', lastSkip
          // «Лимит на аккаунт» — не поломка и не отдых, а прямое указание оператора.
          // Без объяснения задача выглядела оборвавшейся на половине (прогон 19.08:
          // 1 из 2 и статус «Готово»).
          ? (/лимит на аккаунт/.test(lastSkip)
            ? 'Аккаунты выбрали свой лимит действий — добавьте аккаунты или поднимите «сколько сделает 1 аккаунт»'
            : `Ни один аккаунт не может работать сейчас (${lastSkip}) — завершаем`)
          : 'Все аккаунты исчерпали лимиты на эту задачу — завершаем')
        break
      }
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await accountMeta(accountId)
      if (!canModuleUseAccount(task.moduleKey, meta.status || 'active')) {
        idleLap += 1
        lastSkip = `статус ${meta.status}`
        await store.appendLog(task, 'warning', `Пропуск: ${meta.status}`, meta.name)
        continue
      }
      if (perAccountLimitReached(s, accountId, task)) { idleLap += 1; lastSkip = 'лимит на аккаунт'; continue }
      // §4.1–§4.2 (D1/D3): усталость и распорядок — СКВОЗЬ модули. Счётчики живут
      // у аккаунта, поэтому профиль, только что отработавший смену в другом модуле,
      // сюда уже не попадёт: раньше каждая задача считала с нуля и освободившийся
      // аккаунт тут же уходил лить реакции.
      const human = await canWorkNow(accountId)
      if (!human.ok) {
        idleLap += 1
        lastSkip = human.reason
        // Берём САМОЕ РАННЕЕ окно по кругу: ждать надо до первого освободившегося.
        if (human.until) idleUntil = idleUntil ? Math.min(idleUntil, human.until) : human.until
        await store.appendLog(task, 'info', `Пропуск: ${human.reason}`, meta.name)
        continue
      }
      // Удачный бросок тоже показываем: в логе были одни неудачи, и по нему нельзя было
      // понять, как вообще считается шанс (MR-175). Молчим только в часы со 100%: там
      // броска фактически нет, и строка была бы шумом на каждом действии.
      if (typeof human.chance === 'number' && human.chance < 1 && human.reason) {
        await store.appendLog(task, 'info', human.reason, meta.name)
      }
      if (await limitReached(accountId, 'comments')) { idleLap += 1; lastSkip = 'суточный лимит'; await store.appendLog(task, 'info', 'Суточный лимит комментариев достигнут (§6)', meta.name); continue }
      // Многомодульность (20.08): аккаунт может работать в нескольких модулях, но не
      // двумя действиями одновременно — занятый другим модулем пропускаем, как при
      // усталости; сюда же пауза при переключении модулей.
      const busyGate = beginAccountWork(accountId, task.moduleKey, task.id)
      if (!busyGate.ok) {
        idleLap += 1
        lastSkip = busyGate.reason
        if (busyGate.until) idleUntil = idleUntil ? Math.min(idleUntil, busyGate.until) : busyGate.until
        await store.appendLog(task, 'info', `Пропуск: ${busyGate.reason}`, meta.name)
        continue
      }
      idleLap = 0
      lastSkip = ''

      let client
      let progressed = false
      try {
        ;({ client } = await connectAccount(accountId, task.id, { shouldStop: stopFlag(task) }))
        const ch = chs[Math.floor(Math.random() * chs.length)]

        /*
         * Кубик модуля бросаем ДО вступления.
         *
         * Порядок был обратный, и получалось ровно то, на что жаловался владелец 22.08:
         * «аккаунты работают, но не пишут». В логе это выглядело так — аккаунт ждал
         * полторы минуты, вступал в канал, вступал в группу обсуждения, и только потом
         * бросал кубик и уходил ни с чем. При вероятности 30% (значение по умолчанию)
         * так сгорало семь вступлений из десяти — а вступление Telegram считает жёстче
         * любого другого действия и именно за него отправляет во FloodWait.
         *
         * Бросок один на круг: если он прошёл, первый пост его и использует (иначе
         * вероятность возводилась бы в квадрат — 30% превращались бы в 9%).
         */
        let бросокКруга = Math.random() * 100
        if (!task.readyTargets.includes(`${accountId}:${String(ch).replace(/^@/, '').trim()}`) && бросокКруга > prob) {
          await store.appendLog(task, 'info', `Пропуск: вероятность модуля ${Math.round(prob)}% (с учётом защиты), выпало ${Math.round(бросокКруга)} — мимо, в канал не вступаю впустую`, meta.name)
          await disconnectAccount(client, accountId)
          if (trackIdlePass(task, false)) {
            await store.appendLog(task, 'error', 'Остановка: комментарий не отправлен после нескольких попыток')
            break
          }
          await store.saveTask(task)
          continue
        }

        const joinDelay = pickJoinDelay(s.delays?.join?.[0] ?? 84, s.delays?.join?.[1] ?? 156, mul)
        const membership = await prepareTarget(
          client,
          ch,
          (level, message, acc) => store.appendLog(task, level, message, acc),
          meta.name,
          joinDelay,
          task.readyTargets,
          accountId,
          makeStopCheck(store, task.id), // #6: прерываемая задержка вступления
        )
        if (!membership?.peer) {
          await disconnectAccount(client, accountId)
          if (trackIdlePass(task, false)) {
            await store.appendLog(task, 'error', 'Остановка: не удалось вступить в канал')
            break
          }
          await store.saveTask(task)
          continue
        }
        const channel = membership.peer
        if (membership.status === 'joined') await incAction(accountId, 'joins') // §6: суточный лимит вступлений

        // §3.5: окно постов — обрабатываем только последние N, не всю историю канала.
        const fetched = await fetchPosts(client, channel, Math.min(50, Math.max(1, Number(s.postWindow) || 20)))
        // Мониторинг: оставляем только то, что вышло ПОСЛЕ первого захода в этот канал.
        let posts = fetched
        if (Number(s.postFilter) === 4 && fetched.length) {
          const top = Math.max(...fetched.map((p) => p.id))
          if (!seenTop.has(ch)) {
            seenTop.set(ch, top)
            const через = monitorPoll()
            idleLap += 1
            lastSkip = 'мониторинг: ждём новый пост'
            idleUntil = idleUntil ? Math.min(idleUntil, Date.now() + через) : Date.now() + через
            await store.appendLog(task, 'info', `Мониторинг @${ch}: запомнил последний пост #${top}, жду новых — проверю через ${fmtDelay(через)}`, meta.name)
            posts = []
          } else {
            posts = fetched.filter((p) => p.id > seenTop.get(ch))
            if (!posts.length) {
              const через = monitorPoll()
              idleLap += 1
              lastSkip = 'мониторинг: новых постов нет'
              idleUntil = idleUntil ? Math.min(idleUntil, Date.now() + через) : Date.now() + через
              await store.appendLog(task, 'info', `Новых постов нет: @${ch} — проверю через ${fmtDelay(через)}`, meta.name)
            }
          }
        }
        if (!posts.length) {
          if (!fetched.length) await store.appendLog(task, 'warning', 'В канале нет постов для комментирования', meta.name)
        } else {
          const candidates = pickCommentCandidates(posts, s)
          if (!candidates.length) {
            await store.appendLog(task, 'warning', 'Нет подходящих постов (фильтры или ключевые слова)', meta.name)
          }
          for (const post of candidates) {
            if (task.stopRequested || totalLimitReached(s, task)) break

            const key = `${accountId}:${ch}:${post.id}`
            if (task.actionKeys.includes(key)) continue

            // Первый пост круга использует бросок, сделанный перед вступлением, — второй
            // раз кубик на него не бросаем (см. комментарий выше про 30% → 9%).
            const бросокК = бросокКруга ?? Math.random() * 100
            бросокКруга = null
            if (бросокК > prob) {
              await store.appendLog(task, 'info', `Пропуск: вероятность модуля ${Math.round(prob)}% (с учётом защиты), выпало ${Math.round(бросокК)} — мимо`, meta.name)
              continue
            }

            const waitMs = pickDelay(s.delays?.comment?.[0] ?? 30, s.delays?.comment?.[1] ?? 120, mul) * 1000
            await noteWait(task, store, waitMs, 'задержка перед комментарием', meta.name)
            if (await interruptibleSleep(waitMs, makeStopCheck(store, task.id))) break // #6
            const postText = (post.message || '').trim() || (post.media ? '[медиа]' : '')
            // §3.5 семантика: пропускаем посты, семантически далёкие от цели кампании.
            if (goalVec) {
              const pv = await embedText(postText, task.userId)
              const sim = pv ? cosineSimilarity(pv, goalVec) : 1 // нет вектора поста → не режем
              if (sim < semanticThreshold) {
                await store.appendLog(task, 'info', `Пропуск по семантике (близость к цели ${sim.toFixed(2)} < ${semanticThreshold})`, meta.name)
                continue
              }
            }
            // §3.5: если задано распределение типов — на каждый коммент выбираем тип по весу.
            const { index: typeIdx, sys: sysPrompt } = pickPrompt(s, s.typeWeights)
            task.usedTexts = task.usedTexts || []
            // §10.5: если включён анализ изображений и в посте есть фото — описываем
            // картинку и добавляем к тексту поста, чтобы коммент был по сути изображения,
            // а не по «[медиа]». Семантику (выше) считаем по исходному тексту, чтобы фильтр
            // не поехал; обогащаем только то, что уходит в генерацию. Расход vision — с
            // множителем «картинка ×N» из админки. Всё best-effort.
            let genText = postText
            let imageBill = null // §10.5: биллим vision ПОСЛЕ успешной отправки коммента,
            // иначе неудачная отправка (пост не помечается) переописывала/перебилливала фото каждый круг.
            if (s.analyzeImages && messageHasPhoto(post)) {
              const desc = await describeIncomingImage(client, post).catch(() => null)
              if (desc?.text) {
                genText = postText && postText !== '[медиа]' ? `${postText}\n[на изображении: ${desc.text}]` : `[изображение: ${desc.text}]`
                let coinMultiplier = 4
                try { coinMultiplier = (await effectivePrices()).imageMultiplier } catch { /* дефолт ×4 */ }
                imageBill = { ...desc.usage, module: task.moduleKey, accountId, taskId: task.id, campaignId: s.campaignId, userId: task.userId, coinMultiplier }
              }
            }
            const { text, mode, reason, usage } = await generateComment(genText, typeIdx, sysPrompt + goalCtx + agentCtx, { avoid: task.usedTexts, variantSeed: accountId })
            // C1: расход токенов — построчно, с привязкой к модулю/аккаунту/задаче.
            if (usage?.tokens) await recordTokens({ ...usage, module: task.moduleKey, accountId, taskId: task.id, campaignId: s.campaignId, userId: task.userId })
            // Ключ мёртв: продолжать — значит лить шаблонные отписки от живых аккаунтов
            // в реальные каналы (прогон 21.07). Останавливаем всю задачу, а не аккаунт.
            if (mode === 'fatal') {
              await failTask(task, store, `ИИ недоступен: ${reason}. Задача остановлена — комментарии без ИИ не публикуем.`, meta.name)
              break
            }
            if (mode !== 'openai') {
              const hint = mode === 'template_no_key'
                ? 'Шаблон (нет OPENAI_API_KEY в .env)'
                : 'Шаблон (OpenAI недоступен)'
              await store.appendLog(task, 'warning', hint, meta.name)
            }
            try {
              /*
               * Набор комментария — как у человека (просьба владельца 21.08 про скорость
               * печати). Раньше пауза перед комментарием бралась только из настроек модуля
               * и не зависела от текста: аккаунт «печатал» две строки и абзац одинаково
               * быстро. У ответов в чатах и диалогах это давно считается по длине — здесь
               * не считалось, хотя комментарий человек тоже набирает руками.
               */
              const набор = typingPlan(text, (post.message || '').length)
              await noteWait(task, store, набор.totalMs, `читает пост ${fmtDelay(набор.readMs)}, набирает ${describeTyping(набор)}`, meta.name)
              if (await interruptibleSleep(набор.totalMs, makeStopCheck(store, task.id))) break
              await sendChannelComment(client, channel, post.id, text)
              task.actionKeys.push(key)
              // §10.5: коммент ушёл — теперь биллим расход vision (описание картинки поста).
              if (imageBill) await recordTokens(imageBill).catch(() => { /* биллинг не роняет коммент */ })
              task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
              task.accountStats[accountId].actions += 1
              await incAction(accountId, 'comments') // §6: суточный лимит действий
              await bumpProgress(task, store)
        await noteAction(accountId) // §4.3: усталость общая для всех модулей
              await noteAction(accountId) // §4.3: действие копится У АККАУНТА, а не в задаче
              await store.appendHistory(task, {
                id: `${task.id}_${Date.now()}`,
                ts: new Date().toISOString(),
                accountName: meta.name,
                channel: ch,
                comment: text,
                status: 'sent',
              }, 'commentHistory')
              // LOG-002: единый журнал действий (docs/CONTRACT-action-log). Best-effort.
              void recordAction({ type: 'comment', accountId, accountName: meta.name, target: ch, targetTitle: ch, objectRef: { postId: post.id, url: `https://t.me/${String(ch).replace(/^@/, '')}/${post.id}` }, value: { text }, moduleKey: task.moduleKey, taskId: task.id, goalId: task.goalId, initiator: task.initiator })
              // Запоминаем отправленное, чтобы следующий аккаунт не написал то же слово в слово.
              task.usedTexts.push(text)
              if (task.usedTexts.length > 50) task.usedTexts.shift()
              await store.appendLog(task, 'success', `Коммент: ${text.slice(0, 50)}…`, meta.name)
              progressed = true
              break
            } catch (commentErr) {
              // «Не пишет, хотя вступил» (жалоба владельца 22.08). Ошибку запрета больше не
              // пересказываем догадкой — спрашиваем у Telegram, кто виноват: чат или аккаунт.
              // Если аккаунт — дальше крутить его по кругам бессмысленно и вредно: каждый
              // круг это лишнее вступление здоровым аккаунтом не станет.
              const запрет = /USER_BANNED_IN_CHANNEL|CHAT_WRITE_FORBIDDEN/i.test(`${commentErr?.errorMessage || commentErr?.message || ''}`)
              if (запрет) {
                const диагноз = await diagnoseWriteBan(client, commentErr.writePeer || channel)
                await store.appendLog(task, 'error', диагноз.text, meta.name)
                if (диагноз.scope === 'account') {
                  await applySpamblockPolicy(task, accountId, store, meta.name)
                  break
                }
              } else {
                await store.appendLog(task, 'error', mapTelegramError(commentErr), meta.name)
              }
            }
          }
        }
        await disconnectAccount(client, accountId)
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        else endAccountWork(accountId, task.id) // подключение сорвалось — слот занятости не держим
        if (!(await handleFlood(task, accountId, store, err, s, meta.name))) {
          await store.appendLog(task, 'error', mapTelegramError(err), meta.name)
        }
      }

      if (trackIdlePass(task, progressed)) {
        await store.appendLog(task, 'error', 'Остановка: комментарий не отправлен после нескольких попыток')
        break
      }

      task = (await store.loadTask(task.id)) || task
      task.readyTargets = task.readyTargets || []
      task.actionKeys = task.actionKeys || []
      await store.saveTask(task)
      // Пауза между кругами была НЕВИДИМОЙ: в логе шли действия подряд, а между ними
      // молча стояли секунды. На вопрос «работают ли задержки» ответить было нечем —
      // ровно это и всплыло на прогоне 22.08. Теперь пауза называет себя и попадает
      // в общий счёт ожидания задачи.
      const пауза752 = pickDelay(5, 15, mul) * 1000
      await noteWait(task, store, пауза752, 'пауза между действиями')
      if (await breakableDelay(пауза752, store, task)) break
    }
    task.status = statusAfterRun(task)
    await store.appendLog(task, task.status === 'error' ? 'error' : 'info', finishNote(task))
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
}

/** @param {object} task @param {object} store */
export async function runNeuroChatting(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  task.readyTargets = task.readyTargets || []
  await store.saveTask(task)
  await store.appendLog(task, 'info', 'Нейрочаттинг запущен')
  const goalCtx = await buildGoalContext(s.goalId)
  // A3.3: тон, роль и запреты берём у АГЕНТА задачи, а не у цели (SPEC §1.2).
  // Пустая строка, если агент не выбран — генерация работает как раньше.
  const agentCtx = await buildAgentContext(s.agentId)
  // Дожим тоже принадлежит агенту: «дожимать или отпускать» — манера общения.
  // Для задач без агента остаётся цель — старые кампании продолжают работать.
  const agentObj = s.agentId ? await getAgent(s.agentId).catch(() => null) : null
  if (goalCtx) await store.appendLog(task, 'info', 'Ответы генерируются к выбранной цели (с базой знаний)')
  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const prob = effectiveProbability(s.probability ?? 30, !!s.aiProtection, s.protectionLevel ?? 1)
  const groups = targets(s)
  let idx = 0
  let idleLap = 0
  // Почему круг оказался пустым: без этого задача завершалась словами «исчерпали
  // лимиты» даже когда всех отсеял распорядок — и ноль действий читался как поломка.
  let lastSkip = ''
  // Ближайшее время, когда хоть один аккаунт снова сможет работать (0 — неизвестно).
  let idleUntil = 0
  const accountIds = s.accountIds || []

  try {
    while (!task.stopRequested && !task.pauseRequested && !totalLimitReached(s, task)) {
      // §9.4: дедлайн цели останавливает и УЖЕ ИДУЩУЮ работу, а не только новые запуски.
      if (await goalExpired(s)) {
        await store.appendLog(task, 'warning', 'Цель просрочена — работа по ней остановлена (§9.4)')
        task.stopRequested = true
        break
      }
      if (idleLap >= accountIds.length) {
        // Временная причина (отдых/распорядок) — ждём ближайшее окно, а не завершаем
        // задачу на полпути (см. развёрнутый комментарий у первого такого блока).
        const plan = idleWaitPlan(idleUntil)
        if (plan.wait) {
          // Причину берём из последнего пропуска: «отдых» — лишь одна из них, бывает
          // ещё распорядок и бросок кубика. Текст «заняты отдыхом» при пропуске по
          // вероятности прямо противоречил соседней строке лога (правка 19.08).
          // Во сколько вернётся ближайший аккаунт — это первое, что спрашивают, глядя
          // на «ждём N мин» (правка 19.08). Задача при этом остаётся в работе.
          const backAt = new Date(idleUntil).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          // Секунды, а не «1 мин»: почти все задержки здесь секундные (переключение
          // модулей, повтор броска), и округление вверх превращало 7 секунд в минуту.
          // Ждём РОВНО до окна — к следующей попытке аккаунт уже готов, а не «попробуем
          // ещё раз и посмотрим». Пауза идёт в общий счёт ожидания задачи.
          await noteWait(task, store, plan.ms, lastSkip
            ? `ждём аккаунт до ${backAt} (${lastSkip})`
            : `ждём ближайший свободный аккаунт до ${backAt}`)
          if (await breakableDelay(plan.ms, store, task)) break
          task = (await store.loadTask(task.id)) || task
          idleLap = 0
          idleUntil = 0
          lastSkip = ''
          continue
        }
        await store.appendLog(task, 'info', lastSkip
          // «Лимит на аккаунт» — не поломка и не отдых, а прямое указание оператора.
          // Без объяснения задача выглядела оборвавшейся на половине (прогон 19.08:
          // 1 из 2 и статус «Готово»).
          ? (/лимит на аккаунт/.test(lastSkip)
            ? 'Аккаунты выбрали свой лимит действий — добавьте аккаунты или поднимите «сколько сделает 1 аккаунт»'
            : `Ни один аккаунт не может работать сейчас (${lastSkip}) — завершаем`)
          : 'Все аккаунты исчерпали лимиты на эту задачу — завершаем')
        break
      }
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await accountMeta(accountId)
      if (!canModuleUseAccount(task.moduleKey, meta.status || 'active') || perAccountLimitReached(s, accountId, task)) { idleLap += 1; lastSkip = 'статус или лимит на аккаунт'; continue }
      // §4.1–§4.2: усталость и распорядок — во ВСЕХ модулях, а не только в комментинге.
      // Иначе «сквозной отдых» дырявый: аккаунт, отработавший смену тут, копил усталость,
      // но никто её не проверял — и он же уходил лить реакции в соседнем модуле.
      const human = await canWorkNow(accountId)
      if (!human.ok) {
        idleLap += 1
        lastSkip = human.reason
        // Берём САМОЕ РАННЕЕ окно по кругу: ждать надо до первого освободившегося.
        if (human.until) idleUntil = idleUntil ? Math.min(idleUntil, human.until) : human.until
        await store.appendLog(task, 'info', `Пропуск: ${human.reason}`, meta.name)
        continue
      }
      // Удачный бросок тоже показываем: в логе были одни неудачи, и по нему нельзя было
      // понять, как вообще считается шанс (MR-175). Молчим только в часы со 100%: там
      // броска фактически нет, и строка была бы шумом на каждом действии.
      if (typeof human.chance === 'number' && human.chance < 1 && human.reason) {
        await store.appendLog(task, 'info', human.reason, meta.name)
      }
      if (await limitReached(accountId, 'comments')) { idleLap += 1; lastSkip = 'суточный лимит'; await store.appendLog(task, 'info', 'Суточный лимит сообщений достигнут (§6)', meta.name); continue }
      // Многомодульность (20.08): аккаунт может работать в нескольких модулях, но не
      // двумя действиями одновременно — занятый другим модулем пропускаем, как при
      // усталости; сюда же пауза при переключении модулей.
      const busyGate = beginAccountWork(accountId, task.moduleKey, task.id)
      if (!busyGate.ok) {
        idleLap += 1
        lastSkip = busyGate.reason
        if (busyGate.until) idleUntil = idleUntil ? Math.min(idleUntil, busyGate.until) : busyGate.until
        await store.appendLog(task, 'info', `Пропуск: ${busyGate.reason}`, meta.name)
        continue
      }
      idleLap = 0
      lastSkip = ''
      let client
      let progressed = false
      try {
        ;({ client } = await connectAccount(accountId, task.id, { shouldStop: stopFlag(task) }))
        const g = groups[Math.floor(Math.random() * groups.length)]

        // Кубик ДО вступления — та же правка, что в нейрокомментинге (жалоба владельца
        // 22.08 «вступают, но не пишут»): вступление это самое лимитируемое действие,
        // тратить его на круг, который заведомо ничего не сделает, нельзя.
        const бросокЧ = Math.random() * 100
        if (бросокЧ > prob) {
          await store.appendLog(task, 'info', `Пропуск: вероятность модуля ${Math.round(prob)}% (с учётом защиты), выпало ${Math.round(бросокЧ)} — мимо, в чат не вступаю впустую`, meta.name)
          await disconnectAccount(client, accountId)
          if (trackIdlePass(task, false)) break
          continue
        }

        const joinDelay = pickJoinDelay(s.delays?.join?.[0] ?? 50, s.delays?.join?.[1] ?? 120, mul)
        const membership = await prepareTarget(
          client,
          g,
          (level, message, acc) => store.appendLog(task, level, message, acc),
          meta.name,
          joinDelay,
          task.readyTargets,
          accountId,
          makeStopCheck(store, task.id), // #6
        )
        if (!membership?.peer) {
          await disconnectAccount(client, accountId)
          if (trackIdlePass(task, false)) break
          continue
        }
        const peer = membership.peer
        if (membership.status === 'joined') await incAction(accountId, 'joins') // §6: суточный лимит вступлений
        const msgs = await fetchPosts(client, peer, 15)
        const msg = msgs[Math.floor(Math.random() * msgs.length)]
        if (!msg) {
          await store.appendLog(task, 'info', 'Нет сообщений в чате', meta.name)
          await disconnectAccount(client, accountId)
          if (trackIdlePass(task, false)) break
          continue
        }
        const chatWait = pickDelay(s.delays?.action?.[0] ?? 42, s.delays?.action?.[1] ?? 78, mul) * 1000
        await noteWait(task, store, chatWait, 'задержка между сообщениями', meta.name)
        if (await breakableDelay(chatWait, store, task)) { await disconnectAccount(client, accountId); break }
        task.usedTexts = task.usedTexts || []
        const chatPrompt = pickPrompt(s, s.typeWeights, goalCtx + agentCtx)
        const { text: reply, mode, reason, usage } = await generateComment(msg.message || '', chatPrompt.index, chatPrompt.sys, { avoid: task.usedTexts, variantSeed: accountId })
        if (usage?.tokens) await recordTokens({ ...usage, module: task.moduleKey, accountId, taskId: task.id, campaignId: s.campaignId, userId: task.userId })
        if (mode === 'fatal') {
          await disconnectAccount(client, accountId)
          await failTask(task, store, `ИИ недоступен: ${reason}. Задача остановлена — писать в чаты без ИИ не будем.`, meta.name)
          break
        }
        if (mode !== 'openai') {
          await store.appendLog(task, 'warning', mode === 'template_no_key' ? 'Шаблон (нет OPENAI_API_KEY)' : 'Шаблон (OpenAI недоступен)', meta.name)
        }
        // §4.4 (D4): человеческий темп — пауза «на чтение» и время «на набор».
        // Мгновенный ответ и «100 слов за полсекунды» — то, по чему Telegram узнаёт бота
        // и банит волной похожие аккаунты.
        // Скорость набора у каждого сообщения СВОЯ (26–44 слова в минуту): одинаковый
        // темп у полусотни аккаунтов — сам по себе признак фермы. Числа пишем в лог:
        // «пауза 14 с» без объяснения читается как зависшая задача (просьба владельца 21.08).
        const pace = typingPlan(reply, (msg.message || '').length)
        await noteWait(task, store, pace.totalMs, `читает ${fmtDelay(pace.readMs)}, набирает ${describeTyping(pace)}`, meta.name)
        await sleep(pace.totalMs)
        await client.sendMessage(peer, { message: reply, replyTo: msg.id })
        // §11.1: переписка в группах — тоже под контролем владельца.
        void recordMessage({ accountId, peer: String(peer?.username || peer?.id || ''), direction: 'in', text: msg.message || '', userId: task.userId, moduleKey: task.moduleKey, taskId: task.id, campaignId: s.campaignId })
        void recordMessage({ accountId, peer: String(peer?.username || peer?.id || ''), direction: 'out', text: reply, userId: task.userId, moduleKey: task.moduleKey, taskId: task.id, campaignId: s.campaignId })
        task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
        task.accountStats[accountId].actions += 1
        await incAction(accountId, 'comments') // §6: групповые сообщения — под лимит комментариев
        await bumpProgress(task, store)
        await noteAction(accountId) // §4.3: усталость общая для всех модулей
        await store.appendHistory(task, { id: `${task.id}_${Date.now()}`, ts: new Date().toISOString(), accountName: meta.name, target: g, text: reply, status: 'sent' })
        // LOG-002: единый журнал действий. Best-effort.
        void recordAction({ type: 'chat', accountId, accountName: meta.name, target: g, targetTitle: g, objectRef: { url: `https://t.me/${String(g).replace(/^@/, '')}` }, value: { text: reply }, moduleKey: task.moduleKey, taskId: task.id, goalId: task.goalId, initiator: task.initiator })
        task.usedTexts.push(reply)
        if (task.usedTexts.length > 50) task.usedTexts.shift()
        await store.appendLog(task, 'success', `Ответ в @${g}`, meta.name)
        progressed = true
        await disconnectAccount(client, accountId)
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        else endAccountWork(accountId, task.id) // подключение сорвалось — слот занятости не держим
        if (!(await handleFlood(task, accountId, store, err, s, meta.name))) {
          await store.appendLog(task, 'error', mapTelegramError(err), meta.name)
        }
      }
      if (trackIdlePass(task, progressed)) {
        await store.appendLog(task, 'error', 'Остановка: нет прогресса после нескольких попыток')
        break
      }
      task = (await store.loadTask(task.id)) || task
      task.readyTargets = task.readyTargets || []
      await store.saveTask(task)
      const пауза956 = pickDelay(5, 15, mul) * 1000
      await noteWait(task, store, пауза956, 'пауза между действиями')
      if (await breakableDelay(пауза956, store, task)) break
    }
    task.status = statusAfterRun(task)
    await store.appendLog(task, task.status === 'error' ? 'error' : 'info', finishNote(task))
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
}

/** @param {object} task @param {object} store */
export async function runMassReact(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  await store.saveTask(task)
  const emojis = s.emojis?.length ? s.emojis : ['👍', '❤️', '🔥']
  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const prob = effectiveProbability(s.probability ?? 50, !!s.aiProtection, s.protectionLevel ?? 1)
  const tgs = targets(s)
  // feature 10: исключаем посты из ЧС по username канала
  const fixedPosts = parseTelegramPostLinks(s.postUrls).filter((p) => !p.username || !isBlacklistedSync(p.username))
  // Режим реакций (18.08). Раньше переключатель в UI никуда не доезжал: воркер всегда брал
  // ПОСЛЕДНИЙ пост канала, поэтому «Мониторинг» и «Существующие сообщения» делали одно и то же.
  //   0 — мониторинг новых: реагируем только на посты, вышедшие ПОСЛЕ старта задачи;
  //   1 — существующие: реагируем на N последних постов.
  const reactMode = Number(s.reactMode) === 1 ? 1 : 0
  const lastPostsCount = normalizeLastPostsCount(s.lastPostsCount)
  // Планка «что уже было» на канал, общая для всех аккаунтов задачи: первый зашедший аккаунт
  // её ставит и не реагирует, дальше реагируем на всё, что вышло выше планки. Живёт в памяти —
  // после рестарта планка встаёт заново, посты из времени простоя новыми не считаются.
  const seenTop = new Map()
  // Один аккаунт не ставит вторую реакцию на тот же пост; разные аккаунты — ставят (в этом смысл модуля).
  const reacted = new Set()
  let idx = 0
  let idleLap = 0
  // Почему круг оказался пустым: без этого задача завершалась словами «исчерпали
  // лимиты» даже когда всех отсеял распорядок — и ноль действий читался как поломка.
  let lastSkip = ''
  // Ближайшее время, когда хоть один аккаунт снова сможет работать (0 — неизвестно).
  let idleUntil = 0
  const accountIds = s.accountIds || []

  try {
    while (!task.stopRequested && !task.pauseRequested && !totalLimitReached(s, task)) {
      // §9.4: дедлайн цели останавливает и УЖЕ ИДУЩУЮ работу, а не только новые запуски.
      if (await goalExpired(s)) {
        await store.appendLog(task, 'warning', 'Цель просрочена — работа по ней остановлена (§9.4)')
        task.stopRequested = true
        break
      }
      if (idleLap >= accountIds.length) {
        // Временная причина (отдых/распорядок) — ждём ближайшее окно, а не завершаем
        // задачу на полпути (см. развёрнутый комментарий у первого такого блока).
        const plan = idleWaitPlan(idleUntil)
        if (plan.wait) {
          // Причину берём из последнего пропуска: «отдых» — лишь одна из них, бывает
          // ещё распорядок и бросок кубика. Текст «заняты отдыхом» при пропуске по
          // вероятности прямо противоречил соседней строке лога (правка 19.08).
          // Во сколько вернётся ближайший аккаунт — это первое, что спрашивают, глядя
          // на «ждём N мин» (правка 19.08). Задача при этом остаётся в работе.
          const backAt = new Date(idleUntil).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          // Секунды, а не «1 мин»: почти все задержки здесь секундные (переключение
          // модулей, повтор броска), и округление вверх превращало 7 секунд в минуту.
          // Ждём РОВНО до окна — к следующей попытке аккаунт уже готов, а не «попробуем
          // ещё раз и посмотрим». Пауза идёт в общий счёт ожидания задачи.
          await noteWait(task, store, plan.ms, lastSkip
            ? `ждём аккаунт до ${backAt} (${lastSkip})`
            : `ждём ближайший свободный аккаунт до ${backAt}`)
          if (await breakableDelay(plan.ms, store, task)) break
          task = (await store.loadTask(task.id)) || task
          idleLap = 0
          idleUntil = 0
          lastSkip = ''
          continue
        }
        await store.appendLog(task, 'info', lastSkip
          // «Лимит на аккаунт» — не поломка и не отдых, а прямое указание оператора.
          // Без объяснения задача выглядела оборвавшейся на половине (прогон 19.08:
          // 1 из 2 и статус «Готово»).
          ? (/лимит на аккаунт/.test(lastSkip)
            ? 'Аккаунты выбрали свой лимит действий — добавьте аккаунты или поднимите «сколько сделает 1 аккаунт»'
            : `Ни один аккаунт не может работать сейчас (${lastSkip}) — завершаем`)
          : 'Все аккаунты исчерпали лимиты на эту задачу — завершаем')
        break
      }
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await accountMeta(accountId)
      if (!canModuleUseAccount(task.moduleKey, meta.status || 'active') || perAccountLimitReached(s, accountId, task)) { idleLap += 1; lastSkip = 'статус или лимит на аккаунт'; continue }
      // §4.1–§4.2: реакции — самый «дешёвый» модуль, и именно им добивали уставшие
      // аккаунты. Проверка та же, что в комментинге: усталость общая.
      const human = await canWorkNow(accountId)
      if (!human.ok) {
        idleLap += 1
        lastSkip = human.reason
        // Берём САМОЕ РАННЕЕ окно по кругу: ждать надо до первого освободившегося.
        if (human.until) idleUntil = idleUntil ? Math.min(idleUntil, human.until) : human.until
        await store.appendLog(task, 'info', `Пропуск: ${human.reason}`, meta.name)
        continue
      }
      // Удачный бросок тоже показываем: в логе были одни неудачи, и по нему нельзя было
      // понять, как вообще считается шанс (MR-175). Молчим только в часы со 100%: там
      // броска фактически нет, и строка была бы шумом на каждом действии.
      if (typeof human.chance === 'number' && human.chance < 1 && human.reason) {
        await store.appendLog(task, 'info', human.reason, meta.name)
      }
      if (await limitReached(accountId, 'reactions')) { idleLap += 1; lastSkip = 'суточный лимит'; await store.appendLog(task, 'info', 'Суточный лимит реакций достигнут (§6)', meta.name); continue }
      // Многомодульность (20.08): аккаунт может работать в нескольких модулях, но не
      // двумя действиями одновременно — занятый другим модулем пропускаем, как при
      // усталости; сюда же пауза при переключении модулей.
      const busyGate = beginAccountWork(accountId, task.moduleKey, task.id)
      if (!busyGate.ok) {
        idleLap += 1
        lastSkip = busyGate.reason
        if (busyGate.until) idleUntil = idleUntil ? Math.min(idleUntil, busyGate.until) : busyGate.until
        await store.appendLog(task, 'info', `Пропуск: ${busyGate.reason}`, meta.name)
        continue
      }
      idleLap = 0
      lastSkip = ''
      let client
      try {
        ;({ client } = await connectAccount(accountId, task.id, { shouldStop: stopFlag(task) }))
        const reactWait = pickDelay(s.delays?.action?.[0] ?? 30, s.delays?.action?.[1] ?? 120, mul) * 1000
        await noteWait(task, store, reactWait, 'задержка перед реакцией', meta.name)
        if (await breakableDelay(reactWait, store, task)) { await disconnectAccount(client, accountId); break }

        let peer
        let postId
        let targetLabel
        // Помечаем пост как «этот аккаунт отработал» только ПОСЛЕ успешной реакции: иначе
        // пост, пропущенный по вероятности, для аккаунта потерян навсегда.
        let reactKey = ''
        // Один бросок на круг: и для ветки «пост по ссылке», и для ветки «канал».
        const бросокКруга = Math.random() * 100

        if (fixedPosts.length) {
          const pt = fixedPosts[Math.floor(Math.random() * fixedPosts.length)]
          targetLabel = pt.username ? `@${pt.username}` : pt.label
          peer = await resolvePostPeer(client, pt)
          postId = pt.msgId
        } else {
          if (!tgs.length) {
            await store.appendLog(task, 'error', 'Укажите группу/канал или ссылку на пост', meta.name)
            await disconnectAccount(client, accountId)
            continue
          }
          const t = tgs[Math.floor(Math.random() * tgs.length)]
          targetLabel = `@${t}`
          // Кубик ДО вступления (см. нейрокомментинг): семь вступлений из десяти при
          // вероятности 30% уходили в пустоту — аккаунт вступал и тут же уходил.
          if (бросокКруга > prob) {
            await store.appendLog(task, 'info', `Пропуск: вероятность модуля ${Math.round(prob)}% (с учётом защиты), выпало ${Math.round(бросокКруга)} — мимо, в канал не вступаю впустую`, meta.name)
            await disconnectAccount(client, accountId)
            continue
          }
          const membership = await joinTargetOrSkip(
            client, t,
            (level, message, acc) => store.appendLog(task, level, message, acc),
            meta.name,
          )
          if (!membership?.peer) {
            await disconnectAccount(client, accountId)
            continue
          }
          peer = membership.peer
          if (membership.status === 'joined') await incAction(accountId, 'joins') // §6: суточный лимит вступлений
          const posts = await fetchPosts(client, peer, reactMode === 1 ? lastPostsCount : 20)
          const pick = pickReactionPost(posts, {
            mode: reactMode,
            lastPostsCount,
            seenTop: seenTop.get(t),
            reacted: (id) => reacted.has(`${accountId}|${t}|${id}`),
          })
          /*
           * Мониторинг — это ОЖИДАНИЕ, а не простой (уточнение владельца 22.08: «если
           * ждёт новые — это не сломан, просто новых постов нет»). Но перечитывать канал
           * каждые 5–15 секунд незачем: посты выходят раз в часы, а мы за это время
           * делаем сотни запросов с каждого аккаунта — прямой путь к FloodWait.
           * Ставим следующую проверку через 5–30 минут (срок случайный) и говорим об
           * этом в логе, чтобы «ноль действий за час» не читалось как поломка.
           */
          if (pick.action === 'baseline') {
            seenTop.set(t, pick.topId)
            const через = monitorPoll()
            idleLap += 1
            lastSkip = 'мониторинг: ждём новый пост'
            idleUntil = idleUntil ? Math.min(idleUntil, Date.now() + через) : Date.now() + через
            await store.appendLog(task, 'info', `Мониторинг ${targetLabel}: запомнил последний пост #${pick.topId}, жду новых — проверю через ${fmtDelay(через)}`, meta.name)
            await disconnectAccount(client, accountId)
            continue
          }
          if (pick.action === 'skip') {
            const why = pick.reason === 'no-posts' ? 'постов нет'
              : pick.reason === 'no-new' ? 'новых постов нет'
                : 'все последние посты уже отработаны этим аккаунтом'
            // «Новых постов нет» — то же ожидание: следующая проверка тоже через 5–30 мин.
            if (pick.reason === 'no-new' || pick.reason === 'no-posts') {
              const через = monitorPoll()
              idleLap += 1
              lastSkip = `мониторинг: ${why}`
              idleUntil = idleUntil ? Math.min(idleUntil, Date.now() + через) : Date.now() + через
              await store.appendLog(task, 'info', `${targetLabel}: ${why} — проверю через ${fmtDelay(через)}`, meta.name)
            } else {
              await store.appendLog(task, 'info', `${targetLabel}: ${why}`, meta.name)
            }
            await disconnectAccount(client, accountId)
            continue
          }
          postId = pick.post.id
          reactKey = `${accountId}|${t}|${pick.post.id}`
        }

        // Вероятность применяется ОДИН раз. Раньше в ветке групп она проверялась дважды,
        // и «50%» на деле давали 25% — реакций выходило вдвое меньше обещанного.
        //
        // Пропуск по вероятности РАНЬШЕ НЕ ПИСАЛСЯ вовсе: действие не происходило, а в
        // логе оставалась дыра — оператор видел «вступил» и сразу «завершено» (прогон
        // 22.08). Пишем и число, и бросок, и откуда взялась цифра: `prob` — это заданная
        // вероятность, уже умноженная на множитель защиты, и расхождение с настройкой
        // («поставил 50, вижу 73») само по себе рождало вопросы.
        // Бросок сделан ДО вступления (выше); здесь он лишь применяется к ветке
        // «реакция на конкретный пост по ссылке», где вступать никуда не нужно.
        if (бросокКруга > prob) {
          await store.appendLog(task, 'info', `Пропуск: вероятность модуля ${Math.round(prob)}% (с учётом защиты), выпало ${Math.round(бросокКруга)} — мимо`, meta.name)
          await disconnectAccount(client, accountId)
          continue
        }

        const emoji = emojis[Math.floor(Math.random() * emojis.length)]
        await sendReaction(client, peer, postId, emoji)
        if (reactKey) reacted.add(reactKey)
        task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
        task.accountStats[accountId].actions += 1
        await incAction(accountId, 'reactions') // §6: суточный лимит реакций
        await bumpProgress(task, store)
        await noteAction(accountId) // §4.3: усталость общая для всех модулей
        await store.appendHistory(task, { id: `${task.id}_${Date.now()}`, ts: new Date().toISOString(), accountName: meta.name, target: targetLabel, emoji, postId, status: 'sent' })
        // LOG-002: единый журнал действий. Best-effort.
        void recordAction({ type: 'reaction', accountId, accountName: meta.name, target: targetLabel, targetTitle: targetLabel, objectRef: { postId, url: `https://t.me/${String(targetLabel).replace(/^@/, '')}/${postId}` }, value: { emoji }, moduleKey: task.moduleKey, taskId: task.id, goalId: task.goalId, initiator: task.initiator })
        await store.appendLog(task, 'success', `Реакция ${emoji} ${targetLabel} · пост #${postId}`, meta.name)
        await disconnectAccount(client, accountId)
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        else endAccountWork(accountId, task.id) // подключение сорвалось — слот занятости не держим
        if (!(await handleFlood(task, accountId, store, err, s, meta.name))) {
          await store.appendLog(task, 'error', mapTelegramError(err), meta.name)
        }
      }
      task = (await store.loadTask(task.id)) || task
      const паузаР = pickDelay(5, 15, mul) * 1000
      await noteWait(task, store, паузаР, 'пауза между действиями')
      if (await breakableDelay(паузаР, store, task)) break
    }
    task.status = statusAfterRun(task)
    await store.appendLog(task, task.status === 'error' ? 'error' : 'info', finishNote(task))
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
}

/** @param {object} task @param {object} store */
export async function runMassLooking(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  await store.saveTask(task)
  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const tgs = targets(s)
  let idx = 0
  let idleLap = 0
  // Почему круг оказался пустым: без этого задача завершалась словами «исчерпали
  // лимиты» даже когда всех отсеял распорядок — и ноль действий читался как поломка.
  let lastSkip = ''
  // Ближайшее время, когда хоть один аккаунт снова сможет работать (0 — неизвестно).
  let idleUntil = 0
  const accountIds = s.accountIds || []
  const lookMode = ['stories', 'posts', 'both'].includes(s.lookMode) ? s.lookMode : 'stories'
  const postsCount = Math.min(Math.max(Math.trunc(Number(s.lookPostsCount) || 0) || 3, 1), 50)

  try {
    while (!task.stopRequested && !task.pauseRequested && !totalLimitReached(s, task)) {
      // §9.4: дедлайн цели останавливает и УЖЕ ИДУЩУЮ работу, а не только новые запуски.
      if (await goalExpired(s)) {
        await store.appendLog(task, 'warning', 'Цель просрочена — работа по ней остановлена (§9.4)')
        task.stopRequested = true
        break
      }
      if (idleLap >= accountIds.length) {
        // Временная причина (отдых/распорядок) — ждём ближайшее окно, а не завершаем
        // задачу на полпути (см. развёрнутый комментарий у первого такого блока).
        const plan = idleWaitPlan(idleUntil)
        if (plan.wait) {
          // Причину берём из последнего пропуска: «отдых» — лишь одна из них, бывает
          // ещё распорядок и бросок кубика. Текст «заняты отдыхом» при пропуске по
          // вероятности прямо противоречил соседней строке лога (правка 19.08).
          // Во сколько вернётся ближайший аккаунт — это первое, что спрашивают, глядя
          // на «ждём N мин» (правка 19.08). Задача при этом остаётся в работе.
          const backAt = new Date(idleUntil).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          // Секунды, а не «1 мин»: почти все задержки здесь секундные (переключение
          // модулей, повтор броска), и округление вверх превращало 7 секунд в минуту.
          // Ждём РОВНО до окна — к следующей попытке аккаунт уже готов, а не «попробуем
          // ещё раз и посмотрим». Пауза идёт в общий счёт ожидания задачи.
          await noteWait(task, store, plan.ms, lastSkip
            ? `ждём аккаунт до ${backAt} (${lastSkip})`
            : `ждём ближайший свободный аккаунт до ${backAt}`)
          if (await breakableDelay(plan.ms, store, task)) break
          task = (await store.loadTask(task.id)) || task
          idleLap = 0
          idleUntil = 0
          lastSkip = ''
          continue
        }
        await store.appendLog(task, 'info', lastSkip
          // «Лимит на аккаунт» — не поломка и не отдых, а прямое указание оператора.
          // Без объяснения задача выглядела оборвавшейся на половине (прогон 19.08:
          // 1 из 2 и статус «Готово»).
          ? (/лимит на аккаунт/.test(lastSkip)
            ? 'Аккаунты выбрали свой лимит действий — добавьте аккаунты или поднимите «сколько сделает 1 аккаунт»'
            : `Ни один аккаунт не может работать сейчас (${lastSkip}) — завершаем`)
          : 'Все аккаунты исчерпали лимиты на эту задачу — завершаем')
        break
      }
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await accountMeta(accountId)
      if (!canModuleUseAccount(task.moduleKey, meta.status || 'active') || perAccountLimitReached(s, accountId, task)) { idleLap += 1; lastSkip = 'статус или лимит на аккаунт'; continue }
      // §4.1–§4.2: просмотры тоже расходуют аккаунт — усталость и распорядок общие.
      const human = await canWorkNow(accountId)
      if (!human.ok) {
        idleLap += 1
        lastSkip = human.reason
        // Берём САМОЕ РАННЕЕ окно по кругу: ждать надо до первого освободившегося.
        if (human.until) idleUntil = idleUntil ? Math.min(idleUntil, human.until) : human.until
        await store.appendLog(task, 'info', `Пропуск: ${human.reason}`, meta.name)
        continue
      }
      // Удачный бросок тоже показываем: в логе были одни неудачи, и по нему нельзя было
      // понять, как вообще считается шанс (MR-175). Молчим только в часы со 100%: там
      // броска фактически нет, и строка была бы шумом на каждом действии.
      if (typeof human.chance === 'number' && human.chance < 1 && human.reason) {
        await store.appendLog(task, 'info', human.reason, meta.name)
      }
      // Многомодульность (20.08): аккаунт может работать в нескольких модулях, но не
      // двумя действиями одновременно — занятый другим модулем пропускаем, как при
      // усталости; сюда же пауза при переключении модулей.
      const busyGate = beginAccountWork(accountId, task.moduleKey, task.id)
      if (!busyGate.ok) {
        idleLap += 1
        lastSkip = busyGate.reason
        if (busyGate.until) idleUntil = idleUntil ? Math.min(idleUntil, busyGate.until) : busyGate.until
        await store.appendLog(task, 'info', `Пропуск: ${busyGate.reason}`, meta.name)
        continue
      }
      idleLap = 0
      lastSkip = ''
      let client
      try {
        ;({ client } = await connectAccount(accountId, task.id, { shouldStop: stopFlag(task) }))
        const t = tgs[Math.floor(Math.random() * tgs.length)]
        const lookWait = pickDelay(s.delays?.action?.[0] ?? 20, s.delays?.action?.[1] ?? 60, mul) * 1000
        await noteWait(task, store, lookWait, 'задержка перед просмотром', meta.name)
        if (await breakableDelay(lookWait, store, task)) { await disconnectAccount(client, accountId); break }
        const membership = await joinTargetOrSkip(
          client, t,
          (level, message, acc) => store.appendLog(task, level, message, acc),
          meta.name,
        )
        if (!membership?.peer) {
          await disconnectAccount(client, accountId)
          continue
        }
        if (membership.status === 'joined') await incAction(accountId, 'joins') // §6: суточный лимит вступлений
        task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
        if (lookMode === 'stories' || lookMode === 'both') {
          const viewed = await markStoriesRead(client, membership.peer)
          await store.appendLog(task, 'success', `Просмотр @${t} (${viewed})`, meta.name)
        }
        if (lookMode === 'posts' || lookMode === 'both') {
          const res = await viewRecentPosts(client, membership.peer, postsCount)
          if (!res.isChannel) {
            await store.appendLog(task, 'warning', `Просмотр постов @${t}: цель не broadcast-канал — счётчик просмотров не применим`, meta.name)
          } else if (res.viewed === 0) {
            const why = res.reason === 'no_posts' ? 'посты не найдены' : 'просмотр не засчитан'
            await store.appendLog(task, 'warning', `Просмотр постов @${t}: ${why}`, meta.name)
          } else {
            const delta = res.viewsBefore != null
              ? ` (просмотры поста: было ${res.viewsBefore}${res.viewsAfter != null ? `, стало ${res.viewsAfter}` : ''})`
              : ''
            await store.appendLog(task, 'success', `Просмотр постов @${t}: ${res.viewed}${delta}`, meta.name)
          }
        }
        task.accountStats[accountId].actions += 1
        await bumpProgress(task, store)
        await noteAction(accountId) // §4.3: усталость общая для всех модулей
        await disconnectAccount(client, accountId)
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        else endAccountWork(accountId, task.id) // подключение сорвалось — слот занятости не держим
        if (!(await handleFlood(task, accountId, store, err, s, meta.name))) {
          await store.appendLog(task, 'error', mapTelegramError(err), meta.name)
        }
      }
      task = (await store.loadTask(task.id)) || task
      const паузаЛ = pickDelay(10, 30, mul) * 1000
      await noteWait(task, store, паузаЛ, 'пауза между действиями')
      if (await breakableDelay(паузаЛ, store, task)) break
    }
    task.status = statusAfterRun(task)
    await store.appendLog(task, task.status === 'error' ? 'error' : 'info', finishNote(task))
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
}

/** @param {object} task @param {object} store */
export async function runWarming(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  await store.saveTask(task)
  // 3 уровня прогрева (§8.2, названия заказчика): длиннее уровень — медленнее/естественнее темп.
  const pace = warmingPace(s.warmLevel ?? 1)
  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1) * pace.mul
  const шаг = Math.round(WARM_WINDOW_MS / Math.max(1, pace.actionsPerDay) / 60000)
  await store.appendLog(task, 'info', `Прогрев запущен · уровень: ${pace.label} · ~${pace.actionsPerDay} действий/день на аккаунт (примерно раз в ${шаг} мин, ночью — пауза)`)
  const accountIds = s.accountIds || []
  // §3.3: на время прогрева аккаунт получает статус «warming» — он входит в NON_RUNNABLE,
  // поэтому боевые модули его не возьмут. Раньше этот статус не выставлял НИКТО: он был
  // описан в state machine, но недостижим, и защита «непрогретый в бой не идёт» держалась
  // только на локе задачи — то есть исчезала в ту же секунду, когда прогрев заканчивался
  // (прогон 21–22.07, тест 12.5).
  for (const id of accountIds) {
    const meta = await accountMeta(id)
    if (meta.status === 'active') await setAccountMeta(id, { status: 'warming' })
  }
  let idx = 0
  let idleLap = 0
  /** Ошибок подряд по аккаунту и кто уже исключён из этого прогона. */
  const fails = new Map()
  const burned = new Set()
  const MAX_ACCOUNT_FAILS = 3

  try {
    while (!task.stopRequested && !task.pauseRequested && !totalLimitReached(s, task)) {
      // §9.4: дедлайн цели останавливает и УЖЕ ИДУЩУЮ работу, а не только новые запуски.
      if (await goalExpired(s)) {
        await store.appendLog(task, 'warning', 'Цель просрочена — работа по ней остановлена (§9.4)')
        task.stopRequested = true
        break
      }
      if (idleLap >= accountIds.length) {
        // Прогрев усталость не спрашивает (у него собственный темп), поэтому ждать
        // нечего — все аккаунты либо в неподходящем статусе, либо исключены по ошибкам.
        await store.appendLog(task, 'info', 'Нет доступных аккаунтов для прогрева — завершаем')
        break
      }
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await accountMeta(accountId)
      if (!canModuleUseAccount(task.moduleKey, meta.status || 'active')) { idleLap += 1; continue }
      // Аккаунт уже исключён из прогона (см. счётчик ошибок ниже) — не долбимся в него
      // снова. Когда исключены все, сработает проверка idleLap выше и задача завершится.
      if (burned.has(accountId)) { idleLap += 1; continue }
      // Многомодульность (20.08): прогрев не смотрит усталость, но «два действия в одну
      // секунду» не делает и он — занятый другим модулем аккаунт пропускаем.
      const busyGate = beginAccountWork(accountId, task.moduleKey, task.id)
      if (!busyGate.ok) {
        idleLap += 1
        await store.appendLog(task, 'info', `Пропуск: ${busyGate.reason}`, meta.name)
        continue
      }
      idleLap = 0
      let client
      try {
        ;({ client } = await connectAccount(accountId, task.id, { shouldStop: stopFlag(task) }))
        // §8.2: тип действия выбирается по пропорции уровня (view/react/read/join/ping).
        // Реальные реакции/вступления выполняются под суточными лимитами §6 (при достижении
        // потолка действие деградирует в безопасный просмотр). Бизнес-логика — Help Center «Политика прогрева».
        const kind = pickWeightedKey(pace.weights)
        const warmQuery = () => ['news', 'music', 'tech', 'crypto', 'sport', 'movies'][Math.floor(Math.random() * 6)]
        if (kind === 'react' && !(await limitReached(accountId, 'reactions'))) {
          const chats = await searchPublic(client, warmQuery(), 6)
          const target = chats[Math.floor(Math.random() * chats.length)]
          let reacted = false
          if (target) {
            try {
              const posts = await fetchPosts(client, target, 5)
              const post = posts[Math.floor(Math.random() * posts.length)]
              if (post) {
                const emoji = ['👍', '❤️', '🔥', '👏'][Math.floor(Math.random() * 4)]
                await sendReaction(client, target, post.id, emoji)
                await incAction(accountId, 'reactions')
                await store.appendLog(task, 'success', `Прогрев: реакция ${emoji} в «${target.title || target.username || 'канал'}»`, meta.name)
                reacted = true
              }
            } catch { /* канал без реакций/приватный — деградируем в просмотр */ }
          }
          if (!reacted) await store.appendLog(task, 'info', 'Прогрев: просмотр каналов · react→view', meta.name)
        } else if (kind === 'join' && !(await limitReached(accountId, 'joins'))) {
          const chats = await searchPublic(client, warmQuery(), 8)
          const target = chats.find((c) => c.username)
          let joined = false
          if (target?.username) {
            const m = await joinTargetOrSkip(client, target.username, (l, msg, a) => store.appendLog(task, l, msg, a), meta.name)
            if (m?.status === 'joined') { await incAction(accountId, 'joins'); joined = true }
            else if (m?.peer) joined = true // уже участник — тоже засчитываем заход
          }
          if (!joined) { await client.getMe(); await store.appendLog(task, 'info', 'Прогрев: keepalive · join→ping', meta.name) }
        } else if (kind === 'read') {
          const ds = await fetchDialogs(client, 10)
          await store.appendLog(task, 'info', `Прогрев: чтение диалогов (${ds.length})`, meta.name)
        } else if (kind === 'ping') {
          await client.getMe()
          await store.appendLog(task, 'info', 'Прогрев: keepalive · ping', meta.name)
        } else {
          const chats = await searchPublic(client, 'news', 5)
          await store.appendLog(task, 'info', `Прогрев: просмотр каналов (${chats.length}) · ${kind}`, meta.name)
        }
        task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
        task.accountStats[accountId].actions += 1
        fails.delete(accountId) // получилось — счётчик ошибок подряд обнуляем
        await bumpProgress(task, store)
        await noteAction(accountId) // §4.3: усталость общая для всех модулей
        await disconnectAccount(client, accountId)
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        else endAccountWork(accountId, task.id) // подключение сорвалось — слот занятости не держим
        if (!(await handleFlood(task, accountId, store, err, s, meta.name))) {
          await store.appendLog(task, 'warning', mapTelegramError(err), meta.name)
        }
        // Аккаунт, который валится раз за разом (мёртвый прокси, битая сессия), нельзя
        // дёргать вечно: до этой правки задача часами писала один и тот же таймаут и не
        // делала ни одного действия. Три ошибки подряд — исключаем до конца прогона.
        const n = (fails.get(accountId) || 0) + 1
        fails.set(accountId, n)
        if (n >= MAX_ACCOUNT_FAILS && !burned.has(accountId)) {
          burned.add(accountId)
          await store.appendLog(task, 'warning', `Аккаунт исключён из прогона: ${MAX_ACCOUNT_FAILS} ошибки подряд · ${mapTelegramError(err)}`, meta.name)
        }
      }
      task = (await store.loadTask(task.id)) || task
      /*
       * ТЕМП ПРОГРЕВА ДЕРЖИТ ОБЕЩАНИЕ (правка 22.08, прогон на живых аккаунтах).
       *
       * Уровень обещает «~10 действий в день», а интерфейс тут же считал: «10 действий ×
       * ~75 с ≈ 13 мин». Замер это подтвердил: два действия за две минуты. То есть дневная
       * норма отрабатывалась за четверть часа, а «7–14 дней» не значили ничего — аккаунт
       * получал суточную активность залпом, ровно как бот.
       *
       * Считаем интервал от обещания: дневная норма растягивается на окно активности
       * (9:00–23:00 — ночью человек спит, §8.2). Разброс ±35%, иначе действия идут по
       * метроному. Нижняя граница — прежняя пауза между действиями: быстрее не нужно.
       */
      const шагПоНорме = Math.round((WARM_WINDOW_MS / Math.max(1, pace.actionsPerDay)) * (0.65 + Math.random() * 0.7))
      const паузаП = Math.max(pickDelay(30, 90, mul) * 1000, шагПоНорме)
      await noteWait(task, store, паузаП, `темп прогрева: ~${pace.actionsPerDay} действий/день`)
      if (await breakableDelay(паузаП, store, task)) break

      // Ночью прогрев спит: активность в 4 утра — сама по себе примета фермы.
      const час = scheduleHour(Date.now())
      if (!inActiveWindow(час)) {
        const доУтра = msUntilHour(9)
        await noteWait(task, store, доУтра, `ночная пауза прогрева: возобновим в 9:00 (сейчас ${час}:00)`)
        if (await breakableDelay(доУтра, store, task)) break
      }
    }
    task.status = statusAfterRun(task)
    await store.appendLog(task, task.status === 'error' ? 'error' : 'info', finishNote(task, 'Прогрев завершён'))
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
  // Прогрев закончился — снимаем «warming», иначе аккаунт навсегда остался бы вне
  // боевых модулей. На паузе не трогаем: задачу ещё продолжат.
  if (!task.pauseRequested) {
    for (const id of accountIds) {
      const meta = await accountMeta(id)
      if (meta.status === 'warming') await setAccountMeta(id, { status: 'active', statusBefore: null })
    }
  }
}

/**
 * Системный промпт для ЛС: промпт карточки + пользовательская инструкция и цель диалога.
 * @param {object} settings @param {string} goal
 */
/**
 * Системный промт авто-ответчика.
 * @param {object} settings
 * @param {string} goal текстовая инструкция диалога (s.dialogGoal)
 * @param {object|null} [goalObj] объект цели кампании — даёт ИИ понимание «что считать выполненным»
 */
/** Что делать на каждой стадии воронки — чтобы диалог двигался, а не топтался. */
const STAGE_HINT = {
  cold: 'Человек ещё не отвечал по сути. Задача — завязать разговор и выяснить интерес.',
  contacted: 'Ответил односложно. Задача — разговорить: задай один короткий вопрос по теме.',
  warm: 'Отвечает по делу. Задача — показать пользу и подвести к целевому действию.',
  interested: 'Спрашивает подробности. Задача — коротко ответить и предложить сделать шаг.',
  hot: 'Готов действовать, просит ссылку или условия. Задача — дать их прямо сейчас, без лишних слов.',
  target: 'Целевое действие выполнено. Только поблагодари и попрощайся.',
  closed: 'Отказался. Извинись одним предложением и попрощайся.',
}

function dialogSystemPrompt(settings, goal, goalObj = null, leadStatus = null, stage = null) {
  const base = resolveSystemPrompt(settings)
  const rules = 'Ты ведёшь личную переписку в Telegram от лица владельца аккаунта. Если в переписке уже есть твоё сообщение — не здоровайся заново и не представляйся: продолжай разговор с того места, где он остановился. Отвечай на языке собеседника, коротко (1–3 предложения), живо и по-человечески. Никогда не сообщай, что ты ИИ или бот.'
  // §9: прощание — не отдельный механизм, а правило промта. ИИ видит историю переписки
  // и сам понимает, что цель достигнута; тогда благодарит и закрывает диалог, а не давит дальше.
  const finish = [
    'Если из переписки видно, что собеседник УЖЕ выполнил целевое действие'
      + (goalObj?.targetAction ? ` (${goalObj.targetAction})` : '')
      + ' или прямо об этом написал — поблагодари, тепло попрощайся и заверши разговор.',
    'Не повторяй просьбу и не уговаривай после выполнения — это выглядит навязчиво.',
    'Если собеседник отказался или попросил не писать — извинись за беспокойство одним предложением и попрощайся.',
  ].join(' ')
  const parts = [base, rules, finish]
  // Стадия лида: без неё ИИ каждый раз начинает разговор заново и воронка стоит.
  if (leadStatus && STAGE_HINT[leadStatus]) parts.push(`Стадия лида — «${leadStatus}». ${STAGE_HINT[leadStatus]}`)
  // Этап из самой цели: заказчик описал воронку своими словами, ИИ должен работать
  // по НЕЙ, а не по нашим машинным статусам.
  if (stage) parts.push(`Сейчас этап ${stage.index} из ${stage.total} по цели: «${stage.name}». Веди разговор именно к нему, следующий этап — только после того, как этот пройден.`)
  // Без этого модель пишет «[тут вставь ссылку]» — и заглушка уходит живому человеку.
  const links = linksFromGoal(goalObj)
  if (links.length) {
    parts.push(`Ссылка для отправки: ${links[0]}. Когда придёт время её дать — вставь её ПОЛНОСТЬЮ, ровно в таком виде. Никаких «[ссылка]», «[тут вставь ссылку]» и прочих заглушек: собеседник видит текст как есть.`)
  }
  if (goalObj?.name) parts.push(`Цель кампании: ${goalObj.name}.`)
  if (goal) parts.push(`Инструкция и цель диалога:\n${goal}`)
  return parts.join('\n\n')
}

/**
 * Стенограмма последних сообщений (от старых к новым) как контекст для модели.
 * @param {Array<{out?: boolean, message?: string}>} msgs сообщения от новых к старым
 */
function buildDialogPrompt(msgs) {
  const lines = []
  let budget = 380 // generateComment обрезает промпт до 500 символов — держим самые свежие реплики
  for (const m of msgs) {
    const text = (m?.message || '').trim()
    if (!text) continue
    const line = `${m.out ? 'Я' : 'Собеседник'}: ${text.slice(0, 200)}`
    if (line.length > budget) break
    budget -= line.length + 1
    lines.unshift(line)
  }
  if (!lines.length) return 'Собеседник: Привет'
  return `Переписка:\n${lines.join('\n')}\n\nНапиши следующий ответ от лица «Я».`
}

/** @param {object} task @param {object} store */
/** Найти лида по контакту (@username/имя) без учёта регистра и «@». @param {object[]} leads @param {string} peer */
function findLeadByPeer(leads, peer) {
  const k = String(peer ?? '').trim().toLowerCase().replace(/^@/, '')
  return (leads || []).find((l) => String(l.peer ?? '').trim().toLowerCase().replace(/^@/, '') === k) || null
}

export async function runNeuroDialogs(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  await store.saveTask(task)
  const replyAll = s.replyScope === 'all'
  await store.appendLog(
    task,
    'info',
    replyAll
      ? 'НейроДиалоги запущены · авто-ответы всем, кто писал (включая уже прочитанные ЛС), сам первым не пишет'
      : 'НейроДиалоги запущены · авто-ответы только на непрочитанные входящие ЛС (сам первым не пишет)',
  )
  const goal = (s.dialogGoal || '').trim()
  if (goal) await store.appendLog(task, 'info', `Цель диалога: ${goal.slice(0, 120)}`)
  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const accountIds = s.accountIds || []
  // Сколько ЛС один аккаунт отвечает за один заход, прежде чем уступить очередь следующему.
  // Пачка ответов подряд с одного номера — самый быстрый путь к PEER_FLOOD и репортам.
  const perPassCap = [2, 4, 6][s.protectionLevel ?? 1] ?? 4
  // §9: сколько сообщений пишем одному лиду. 'untilTarget' — до целевого действия
  // (ограничивают только суточные лимиты и стоп-лист), 'count' — не больше N ответов.
  const replyLimitMode = s.replyLimitMode === 'count' ? 'count' : 'untilTarget'
  const maxRepliesPerLead = Math.max(0, Number(s.maxRepliesPerLead || 0))
  await store.appendLog(
    task,
    'info',
    replyLimitMode === 'count'
      ? `Лимит на лида: до ${maxRepliesPerLead || '∞'} ответов, затем диалог не продолжаем`
      : 'Лимит на лида: пишем, пока не выполнит целевое действие (или не откажется)',
  )
  // Цель нужна классификатору статусов: по ней ИИ понимает, что считать «выполнено».
  const goalObj = s.goalId ? await (async () => { try { const { getGoal } = await import('../goals.js'); return await getGoal(s.goalId) } catch { return null } })() : null
  // Модуль-ответчик работает долго (ждёт входящие ЛС), поэтому при суточном лимите
  // не завершаемся, а тихо простаиваем — лог о достижении лимита пишем один раз на аккаунт.
  const dmCapLogged = new Set()
  /** Об отдыхе аккаунта сообщаем один раз, а не каждый круг — иначе лог заливает. */
  const restLogged = new Set()
  /** Кому уже сказали, что он работает только на приём (спамблок). */
  const replyOnlyLogged = new Set()
  // Последнее входящее сообщение, на которое уже ответили: не отвечаем дважды на одно и то же,
  // но отвечаем снова, когда собеседник напишет новое.
  const answeredUpTo = new Map()

  try {
    /** Один ПОТОК: крутит свой набор аккаунтов, пока задачу не остановят. */
    const runThread = async (myAccounts, threadNo = 0) => {
    let idx = 0
    let skips = 0
    // Расфазировка потока: своя случайная «фаза» и джиттер на каждый круг. Без этого
    // потоки быстро выравниваются и начинают стучать в Telegram синхронно — а ровный
    // машинный ритм от нескольких аккаунтов и есть кластер, который видно со стороны.
    // Задержки здесь маленькие (доли секунды–секунды): они не тормозят работу,
    // а только сбивают совпадение моментов.
    const phase = Math.random() * 2500 + threadNo * 400
    if (phase) await sleep(phase)
    while (!task.stopRequested && !task.pauseRequested && !totalLimitReached(s, task)) {
      // §9.4: дедлайн цели останавливает и УЖЕ ИДУЩУЮ работу, а не только новые запуски.
      if (await goalExpired(s)) {
        await store.appendLog(task, 'warning', 'Цель просрочена — работа по ней остановлена (§9.4)')
        task.stopRequested = true
        break
      }
      // Полный круг из пропусков (лимиты выбраны, аккаунты в карантине) — не крутим цикл вхолостую.
      if (skips >= myAccounts.length) {
        skips = 0
        await sleep(5000)
        continue
      }
      const accountId = myAccounts[idx++ % myAccounts.length]
      const meta = await accountMeta(accountId)
      // Спамблок запрещает писать ПЕРВЫМ, но не мешает ответить тому, кто написал сам.
      // Нейродиалоги только отвечают — значит такой аккаунт здесь полноценно работает.
      // Выбрасывать его означало бы бросить живых собеседников на полуслове.
      if (!canReplyWithStatus(meta.status || 'active')) {
        // Карантин/невалид — это надолго. Раньше такой аккаунт оставался в ротации и
        // проверялся каждый круг: лог забивался «Пропуск аккаунта» до бесконечности,
        // а поток тратил обороты впустую. Теперь выбрасываем его из своего набора.
        const dead = ['quarantine', 'invalid', 'banned'].includes(meta.status)
        if (dead) {
          const at = myAccounts.indexOf(accountId)
          if (at !== -1) myAccounts.splice(at, 1)
          await store.appendLog(task, 'warning', `${meta.name}: ${meta.status} — выведен из работы (осталось ${myAccounts.length})`, meta.name)
          if (!myAccounts.length) { await store.appendLog(task, 'error', 'В потоке не осталось рабочих аккаунтов'); break }
          continue
        }
        skips += 1
        await store.appendLog(task, 'warning', `Пропуск аккаунта: ${meta.status}`, meta.name)
        continue
      }
      // Один раз на аккаунт сообщаем, что он работает «на приём»: оператор видит
      // спамблок в менеджере и иначе решил бы, что задача его зря держит.
      if (isAccountReplyOnly(meta.status) && !replyOnlyLogged.has(accountId)) {
        replyOnlyLogged.add(accountId)
        await store.appendLog(task, 'info', `${meta.name}: спамблок — писать первым нельзя, но отвечать в открытые диалоги можно. Оставляем в работе.`, meta.name)
      }
      if (perAccountLimitReached(s, accountId, task)) {
        skips += 1
        continue
      }
      if (await limitReached(accountId, 'dm')) {
        skips += 1
        if (!dmCapLogged.has(accountId)) {
          dmCapLogged.add(accountId)
          await store.appendLog(task, 'info', 'Суточный лимит ЛС достигнут (§6) — аккаунт простаивает до сброса', meta.name)
        }
        continue
      }
      // §4.1–§4.3: усталость и распорядок. Диалоги их КОПИЛИ (noteAction ниже), но не
      // спрашивали — аккаунт отвечал круглосуточно и сверх порога, хотя усталость общая
      // для всех модулей (аудит 20.08). Уставший пропускаем: собеседник не теряется,
      // ответ придёт следующим кругом, когда аккаунт вернётся, — так же, как человек,
      // который отошёл от телефона.
      const humanDlg = await canWorkNow(accountId)
      if (!humanDlg.ok) {
        skips += 1
        if (!restLogged.has(accountId)) {
          restLogged.add(accountId)
          await store.appendLog(task, 'info', `Пропуск: ${humanDlg.reason}`, meta.name)
        }
        continue
      }
      restLogged.delete(accountId) // вернулся в строй — о следующем отдыхе сообщим заново

      skips = 0
      dmCapLogged.delete(accountId) // снова активен (лимит сброшен новым днём) — разрешаем лог заново
      let client
      try {
        ;({ client } = await connectAccount(accountId, task.id, { shouldStop: stopFlag(task) }))
        const dialogs = await fetchDialogs(client, 20)
        // Авто-режим отвечает только на личные диалоги (ЛС) с людьми — каналы, группы и боты пропускаются.
        const personal = dialogs.filter((d) => d.entity?.className === 'User' && !d.entity?.bot)
        // «Только новые» — непрочитанные. «Всем, кто писал» — любой диалог, где последнее слово за собеседником.
        const waitingRaw = personal.filter((d) => {
          if (!replyAll) return d.unread > 0
          if (d.lastOut || !d.lastMessageId) return false
          return (answeredUpTo.get(`${accountId}:${d.id}`) ?? 0) < d.lastMessageId
        })
        // §3.6: приоритет ответившему — отвечаем сначала горячим/ответившим лидам (CRM).
        const leadsForPrio = await listLeads(s.goalId ? { goalId: s.goalId } : {})
        const waiting = sortDialogsByLeadPriority(waitingRaw, leadsForPrio)
        const pending = waiting.slice(0, perPassCap)
        await store.appendLog(
          task,
          'info',
          `Диалогов просмотрено: ${dialogs.length} · личных: ${personal.length} · ${replyAll ? 'ждут ответа' : 'непрочитанных ЛС'}: ${waiting.length}`
            + (waiting.length > pending.length ? ` · отвечаем ${pending.length}, остальные — на следующем круге` : ''),
          meta.name,
        )
        if (!pending.length) {
          await disconnectAccount(client, accountId)
          await sleep(5000)
          continue
        }
        for (const d of pending) {
          if (task.stopRequested || totalLimitReached(s, task) || perAccountLimitReached(s, accountId, task)) break
          if (await limitReached(accountId, 'dm')) { await store.appendLog(task, 'info', 'Суточный лимит ЛС достигнут (§6)', meta.name); break }

          // §9: сколько сообщений пишем ОДНОМУ лиду. Два режима:
          //  'count'       — не больше maxRepliesPerLead ответов;
          //  'untilTarget' — пишем, пока лид не выполнит целевое действие (или не откажется).
          // В обоих режимах терминальные статусы — стоп: closed (отказ) и target (цель достигнута).
          // Служебные чаты и боты — никогда. Бот ответил на код входа от Telegram
          // (id 777000) и завёл его в CRM как лида: писать туда нельзя ни при каких настройках.
          const SERVICE_IDS = new Set(['777000', '42777', '1087968824'])
          const uname = String(d.username || '').toLowerCase()
          if (SERVICE_IDS.has(String(d.id)) || d.entity?.bot || uname === 'telegram' || /bot$/.test(uname)) {
            await store.appendLog(task, 'info', `«${d.name}»: служебный чат или бот — пропуск`, meta.name)
            continue
          }
          // Ключ лида: юзернейм из сущности важнее имени — список диалогов его не всегда
          // отдаёт, и лид уезжал в CRM под именем («Ilya») вместо «@chornuy001»,
          // а мейлинг заводил того же человека под юзернеймом. Один человек — четыре лида.
          const realUsername = d.username || d.entity?.username || ''
          const peerKey = realUsername ? `@${realUsername}` : (d.id ? `id:${d.id}` : d.name)
          const leadNow = findLeadByPeer(leadsForPrio, peerKey)
          // §9 «дожим»: диалог закрыт (цель достигнута или человек отказался), но он
          // написал САМ — это входящий интерес, а не наша навязчивость. Если в цели
          // включён дожим, отвечаем с отдельным счётчиком и потолком.
          task.followUps = task.followUps || {}
          const fuDone = task.followUps[peerKey] || 0
          // В `pending` попадают только диалоги, где последнее слово за собеседником
          // (или есть непрочитанные), — но условие пишем явно, чтобы дожим не начал
          // срабатывать сам, если фильтрация выше однажды изменится.
          const hasIncoming = d.unread > 0 || !d.lastOut
          // Дожим настраивает КАМПАНИЯ (24.07): она знает цель, этап и пул.
          // `s.followUp` приезжает из настроек задачи; цель — только для кампаний,
          // заведённых до переезда.
          const fuOwner = s.followUp ? { followUp: s.followUp } : goalObj
          const decision = followUpDecision(leadNow, fuOwner, fuDone, hasIncoming)
          if (decision.mode === 'skip') {
            await store.appendLog(task, 'info', `«${peerKey}» ${decision.reason}`, meta.name)
            answeredUpTo.set(`${accountId}:${d.id}`, Math.max(d.lastMessageId ?? 0, answeredUpTo.get(`${accountId}:${d.id}`) ?? 0))
            continue
          }
          const isFollowUp = decision.mode === 'follow-up'
          if (isFollowUp) {
            await store.appendLog(task, 'info', `«${peerKey}»: дожим — написал сам после закрытия (осталось ${decision.left})`, meta.name)
          }
          task.leadReplies = task.leadReplies || {}
          const sentToLead = task.leadReplies[peerKey] || 0
          if (replyLimitMode === 'count' && maxRepliesPerLead > 0 && sentToLead >= maxRepliesPerLead) {
            await store.appendLog(task, 'info', `«${peerKey}»: лимит ответов на лида (${maxRepliesPerLead}) исчерпан`, meta.name)
            answeredUpTo.set(`${accountId}:${d.id}`, Math.max(d.lastMessageId ?? 0, answeredUpTo.get(`${accountId}:${d.id}`) ?? 0))
            continue
          }
          const msgs = await client.getMessages(d.entity, { limit: 6 })
          const last = msgs[0]
          const incoming = (last?.message || '').trim()
          // §10.5: если оператор включил анализ изображений и последнее входящее — с фото,
          // описываем картинку словами и подмешиваем в промпт, чтобы ИИ отвечал по сути,
          // а не игнорировал присланное. Расход vision биллим отдельно, с множителем
          // «картинка ×N» из админки (priceStore.imageMultiplier). Всё best-effort:
          // осечка описания диалог не рвёт — отвечаем по тексту.
          let imageNote = ''
          let imageBill = null // §10.5: расход vision биллим ПОСЛЕ успешной отправки (см. ниже),
          // иначе неудачные проходы (нет OpenAI / заглушка) переописывали и перебилливали
          // то же фото ×N каждый круг. Только ВХОДЯЩЕЕ фото (`!last.out`) — не своё исходящее.
          if (s.analyzeImages && last && !last.out && messageHasPhoto(last)) {
            const desc = await describeIncomingImage(client, last).catch(() => null)
            if (desc?.text) {
              imageNote = desc.text
              let coinMultiplier = 4
              try { coinMultiplier = (await effectivePrices()).imageMultiplier } catch { /* дефолт ×4 */ }
              imageBill = { ...desc.usage, module: task.moduleKey, accountId, taskId: task.id, campaignId: s.campaignId, userId: task.userId, coinMultiplier }
              await store.appendLog(task, 'info', `«${peerKey}»: на входящем фото — «${imageNote.slice(0, 60)}»`, meta.name)
            }
          }
          const prompt = buildDialogPrompt(msgs) + (imageNote ? `\n\n[Собеседник прислал изображение: ${imageNote}]` : '')
          // Знакомство уже состоялось, если МЫ этому человеку писали (мейлинг отправил
          // первое сообщение). Иначе на первом же ответе лид ещё `cold`, этап — 1/5
          // «Знакомство», и ИИ здоровается второй раз, будто разговора не было.
          const weWroteBefore = msgs.some((m) => m?.out && (m.message || '').trim())
          const rawStatus = leadNow?.status || 'cold'
          const effStatus = weWroteBefore && (rawStatus === 'cold') ? 'contacted' : rawStatus
          // В дожиме — свой тон: человек уже прошёл воронку, продавать ему то же
          // самое повторно это верный способ получить блокировку.
          const sysPrompt = dialogSystemPrompt(s, goal, goalObj, effStatus, stageForStatus(goalObj?.stages, effStatus))
            + (isFollowUp ? followUpPrompt(fuOwner, rawStatus, decision.left) : '')
          // Тип промпта — по распределению (если задано), как в остальных модулях.
          const dlgPrompt = pickPrompt(s, s.typeWeights)
          const gen = await generateComment(prompt, dlgPrompt.index, sysPrompt, accountId)
          if (gen?.usage?.tokens) await recordTokens({ ...gen.usage, module: task.moduleKey, accountId, taskId: task.id, campaignId: s.campaignId, userId: task.userId })
          const mode = gen.mode
          // Диалог подаётся модели стенограммой «Я: … / Собеседник: …», и она регулярно
          // копирует эту разметку в ответ. Живой человек 21.07 получил «Я: Отлично!…» —
          // по такому сразу видно робота.
          const reply = cleanDialogReply(gen.text)
          // Личная переписка — не то место, где годится шаблон-заглушка: она подставляла
          // в сообщение стенограмму диалога («По «Переписка: Я: Привет!...» — согласен»)
          // и это уходило собеседнику от имени аккаунта. Нет ИИ — молчим и идём дальше.
          if (mode !== 'openai') {
            await store.appendLog(
              task,
              'error',
              mode === 'template_no_key'
                ? `«${peerKey}»: не отвечаем — нет OPENAI_API_KEY в .env`
                : `«${peerKey}»: не отвечаем — OpenAI недоступен`,
              meta.name,
            )
            continue
          }
          // Заглушка вместо ссылки («[тут вставь ссылку]») уже уходила живому человеку.
          // Молчание лучше: следующий круг сгенерирует заново, а сказанного не вернуть.
          if (!reply || hasPlaceholder(reply)) {
            await store.appendLog(task, 'warning', `«${peerKey}»: ответ не отправлен — ИИ оставил заготовку вместо текста`, meta.name)
            continue
          }
          const dlgWait = pickDelay(s.delays?.action?.[0] ?? 5, s.delays?.action?.[1] ?? 30, mul) * 1000
          await noteWait(task, store, dlgWait, 'задержка перед ответом в ЛС', meta.name)
          await sleep(dlgWait)
          // §4.4: читаем и печатаем как человек. Это десятки секунд на длинном ответе —
          // без строки в логе выглядело как зависшая задача.
          const dlgPace = typingPlan(reply, incoming.length)
          await noteWait(task, store, dlgPace.totalMs, `читает ${fmtDelay(dlgPace.readMs)}, набирает ${describeTyping(dlgPace)}`, meta.name)
          await sleep(dlgPace.totalMs)
          await client.sendMessage(d.entity, { message: reply })
          // §11.1: сохраняем ОБЕ реплики — входящую и наш ответ. Владелец отвечает за то,
          // что пишут его аккаунтами, поэтому переписка хранится целиком. Best-effort.
          void recordMessage({ accountId, peer: peerKey, direction: 'in', text: incoming, userId: task.userId, moduleKey: task.moduleKey, taskId: task.id, campaignId: s.campaignId })
          void recordMessage({ accountId, peer: peerKey, direction: 'out', text: reply, userId: task.userId, moduleKey: task.moduleKey, taskId: task.id, campaignId: s.campaignId })
          // §10.5: теперь, когда ответ реально ушёл, биллим расход vision (описание фото).
          if (imageBill) await recordTokens(imageBill).catch(() => { /* биллинг не роняет диалог */ })
          // Помечаем прочитанным, чтобы не отвечать повторно одному и тому же собеседнику.
          await readUserHistory(client, d.entity)
          answeredUpTo.set(`${accountId}:${d.id}`, Math.max(last?.id ?? 0, d.lastMessageId ?? 0))
          task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
          task.accountStats[accountId].actions += 1
          task.leadReplies[peerKey] = sentToLead + 1 // §9: счётчик ответов этому лиду
          // Дожим считаем отдельно: у него свой потолок из цели, и обычный лимит
          // ответов на лида к нему отношения не имеет.
          if (isFollowUp) {
            task.followUps[peerKey] = (task.followUps[peerKey] || 0) + 1
            // Дожим отмечаем и У ЛИДА: счётчик в задаче живёт до её конца, а цели
            // нужно знать, скольких довели дожимом, — это отдельная цифра в отчёте.
            if (leadNow?.id) {
              await updateLead(leadNow.id, { followUps: (Number(leadNow.followUps) || 0) + 1 })
                .catch(() => { /* CRM недоступна — из-за счётчика диалог не рвём */ })
            }
          }
          await incAction(accountId, 'dm') // §6: суточный лимит ЛС
          await bumpProgress(task, store)
        await noteAction(accountId) // §4.3: усталость общая для всех модулей
          await store.appendHistory(task, { id: `${task.id}_${Date.now()}`, ts: new Date().toISOString(), accountName: meta.name, target: d.name, text: reply, status: 'sent' })
          // LOG-002: единый журнал действий (ответ в личном диалоге). Best-effort.
          void recordAction({ type: 'dialog', accountId, accountName: meta.name, target: d.name, targetTitle: d.name, value: { text: reply }, moduleKey: task.moduleKey, taskId: task.id, goalId: task.goalId, initiator: task.initiator })
          const inPreview = incoming ? incoming.slice(0, 60) : '[без текста]'
          await store.appendLog(task, 'success', `Ответ в ЛС «${d.name}» → «${reply.slice(0, 60)}» (на: «${inPreview}»)`, meta.name)

          // §9: лид попадает в CRM САМ. Сначала фиксируем сам факт переписки
          // (`contacted`), иначе ответы авто-ответчика проходили мимо CRM. upsertLead
          // двигает только вперёд, поэтому прогретый лид этим вызовом не сбросится.
          // Цель — счётчик, воронкой владеет КАМПАНИЯ: лид создаётся, если есть кампания
          // ИЛИ цель (раньше — только при цели, и кампания без цели не набирала CRM).
          if (s.goalId || s.campaignId) {
            try {
              // Владелец лида — хозяин задачи: без него лид ложится «ничьим» и попадает
              // в общую кучу, откуда его видит вся платформа (аудит 21.08).
              const { created } = await upsertLead({ userId: task.userId, goalId: s.goalId, campaignId: s.campaignId, taskId: task.id, accountId, peer: peerKey, status: 'contacted' })
              if (created) await store.appendLog(task, 'info', `Новый лид в CRM: ${peerKey}`, meta.name)
            } catch (e) {
              // CRM не должна ронять переписку — диалог важнее записи о нём.
              await store.appendLog(task, 'warning', `Лид не записан в CRM: ${e instanceof Error ? e.message : 'ошибка'}`, meta.name)
            }
          }

          // §9: а по ТЕКСТУ ответа определяем стадию воронки и двигаем лида дальше.
          // «Верим на слово»: target ставится, если человек сам сказал, что подписался —
          // фактическая проверка (админ-аккаунт / инвайт-ссылки) будет отдельно.
          if ((s.goalId || s.campaignId) && incoming) {
            try {
              // Лид ищем в его ячейке: кампания (если есть) владеет воронкой, иначе цель.
              const cur = findLeadByPeer(await listLeads(s.campaignId ? { campaignId: s.campaignId } : { goalId: s.goalId }), peerKey)
              const verdict = await classifyLeadReply({
                text: incoming,
                currentStatus: cur?.status || 'cold',
                goalName: goalObj?.name || '',
                targetAction: goalObj?.targetAction || '',
                userId: task.userId,
              })
              if (isFollowUp) {
                // В дожиме обычная воронка не работает: она ходит только вперёд, а лид
                // уже в конце. Здесь важен исход самого дожима — отказался или ожил.
                const next = followUpStatus(cur?.status || 'target', verdict.status)
                // Пишем через updateLead, а не upsertLead: последний двигает статус
                // только вперёд и терминальный не трогает вообще — то есть исход
                // дожима до CRM бы не доехал.
                if (next && cur?.id) {
                  await updateLead(cur.id, { status: next })
                  await store.appendLog(task, next === 'closed' ? 'info' : 'success',
                    `Дожим «${peerKey}»: ${cur.status} → ${next} (${verdict.reason})`, meta.name)
                }
              } else if (shouldAdvance(cur?.status || 'cold', verdict.status)) {
                await upsertLead({ userId: task.userId, peer: peerKey, goalId: s.goalId, campaignId: s.campaignId, taskId: task.id, accountId, status: verdict.status })
                await store.appendLog(
                  task,
                  verdict.status === 'hot' || verdict.status === 'target' ? 'success' : 'info',
                  `Лид «${peerKey}»: ${cur?.status || 'новый'} → ${verdict.status} (${verdict.reason}, ${verdict.mode})`,
                  meta.name,
                )
              }
            } catch (e) {
              await store.appendLog(task, 'warning', `Статус лида не обновлён: ${e instanceof Error ? e.message : e}`, meta.name)
            }
          }
        }
        await disconnectAccount(client, accountId)
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        else endAccountWork(accountId, task.id) // подключение сорвалось — слот занятости не держим
        if (!(await handleFlood(task, accountId, store, err, s, meta.name))) {
          await store.appendLog(task, 'error', mapTelegramError(err), meta.name)
        }
      }
      task = (await store.loadTask(task.id)) || task
      // Джиттер поверх основной паузы: ±40%, чтобы круги потоков не совпадали.
      const base = pickDelay(10, 25, mul) * 1000
      await sleep(Math.round(base * (0.8 + Math.random() * 0.4)))
    }
    }

    // §3.9: потоки. Аккаунты делятся между ними и работают независимо — но всё это
    // ОДНА задача: свой прогресс, свои логи, один «Стоп». Потоков не больше, чем
    // аккаунтов: пустой поток крутил бы цикл вхолостую.
    const threads = Math.max(1, Math.min(Number(s.threads) || 1, accountIds.length))
    if (threads > 1) {
      const groups = Array.from({ length: threads }, () => [])
      accountIds.forEach((id, i) => groups[i % threads].push(id))
      await store.appendLog(task, 'info', `Асинхронный режим: ${threads} поток(ов) на ${accountIds.length} аккаунт(ов)`)
      await Promise.all(groups.filter((g) => g.length).map((g, i) => (async () => {
        // Разбег стартов: одновременный залп читается как ферма. Пауза случайная и
        // НЕ кратная номеру потока — иначе получился бы ровный шаг 10с, 20с, 30с.
        if (i > 0) await sleep(Math.round(pickDelay(5, 20, mul) * 1000 * (0.4 + Math.random() * 1.2)))
        return runThread(g, i)
      })()))
    } else {
      await runThread(accountIds)
    }
    task.status = statusAfterRun(task)
    await store.appendLog(task, 'info', task.status === 'stopped' ? 'Остановлено' : 'Завершено')
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
}

/** Статусы, которые GGR не имеет права перезатирать успешной проверкой сессии. */
const GGR_PROTECTED_STATUSES = new Set(['quarantine', 'spamblock', 'banned'])

/** Ошибка означает, что сессия действительно мертва (а не сеть/прокси моргнули). */
function isDeadSessionError(err) {
  const msg = `${err?.errorMessage || err?.message || ''}`
  return /NO_SESSION|AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|UNAUTHORIZED/i.test(msg)
}

/** @param {object} task @param {object} store */
export async function runGgr(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  const allIds = [...(s.accountIds || [])]

  if (!allIds.length) {
    const { loadAllMeta } = await import('../accountsMeta.js')
    const meta = await loadAllMeta()
    allIds.push(...Object.keys(meta).filter((id) => !meta[id].inTrash))
  }
  task.progress.total = allIds.length
  await store.saveTask(task)
  await store.appendLog(task, 'info', `AIR-проверка: ${allIds.length} аккаунтов`)

  try {
    for (const accountId of allIds) {
      if (task.stopRequested || task.pauseRequested) break
      const meta = await accountMeta(accountId)

      // Аккаунт, занятый другой задачей, не трогаем: параллельный коннект той же сессией
      // роняет обе задачи и может выглядеть для Telegram как угон сессии.
      try {
        assertAccountAvailable(accountId, task.id)
      } catch {
        await store.appendLog(task, 'warning', 'Аккаунт занят другим модулем — пропущен', meta.name)
        continue
      }

      let client
      try {
        const sessionStr = await loadSessionString(accountId)
        if (!sessionStr) throw new Error('NO_SESSION')
        client = await createClient(sessionStr, meta.proxy, accountFingerprint(accountId, meta))
        const me = await client.getMe()
        let score = 50
        if (me.username) score += 15
        if (me.phone) score += 10
        await client.disconnect()
        // Карантин/спамблок/бан — «сессия жива, но аккаунт наказан». Статус не понижаем и не поднимаем.
        const nextStatus = GGR_PROTECTED_STATUSES.has(meta.status) ? meta.status : 'active'
        await setAccountMeta(accountId, { status: nextStatus, ggrScore: score })
        task.results.push({ accountId, name: meta.name, score, status: 'valid' })
        await store.appendLog(task, 'success', `GGR ${score}/100 — ${meta.name}`, meta.name)
      } catch (err) {
        if (client) try { await client.disconnect() } catch { /* */ }
        if (isDeadSessionError(err)) {
          task.results.push({ accountId, name: meta.name, score: 0, status: 'invalid' })
          await setAccountMeta(accountId, { status: 'reauth', ggrScore: 0 })
          await store.appendLog(task, 'error', `Невалидная сессия — ${meta.name}`, meta.name)
        } else {
          // Сеть, прокси, таймаут, FloodWait — сессия не виновата, статус и балл не трогаем.
          task.results.push({ accountId, name: meta.name, score: meta.ggrScore ?? 0, status: 'error' })
          await store.appendLog(task, 'warning', `Проверка не удалась: ${mapTelegramError(err)}`, meta.name)
        }
      }
      task.progress.actionsDone = (task.progress.actionsDone || 0) + 1
      task.progress.done = task.progress.actionsDone
      await store.saveTask(task)
    }
    task.status = statusAfterRun(task)
    const valid = task.results.filter((r) => r.status === 'valid').length
    await store.appendLog(task, 'info', `Проверено ${task.results.length} аккаунтов · валидных ${valid}`)
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
}

/**
 * Богатый парсер каналов/групп (GRAMGPT-style): поиск по ключевым словам + окончаниям,
 * ротация аккаунтов, диапазон участников, фильтры активности/комментариев, дедуп, задержки.
 * @param {object} task @param {object} store @param {'parsing'|'parsing-groups'} kind
 */
export async function runChannelParser(task, store, kind) {
  const s = task.settings
  // Продолжение с паузы, а не запуск с нуля. Раньше здесь безусловно стояло
  // `task.results = []`, и цикл начинался с первого запроса: после «Запустить/
  // возобновить» счётчик найденного обнулялся, total пересчитывался, а уже собранные
  // результаты ТЕРЯЛИСЬ (прогон 21–22.07, тест 6.1: было 10/100 и 10 результатов,
  // стало 0 и сбор заново). Интерфейс при этом обещает «продолжить» одинаково для
  // всех модулей, поэтому чиним здесь, а не в подписи кнопки.
  const resuming = Number(task.cursor) > 0
  task.startedAt = resuming ? (task.startedAt || Date.now()) : Date.now()
  task.status = 'running'
  if (!resuming) {
    task.results = []
    task.cursor = 0
  }
  await store.saveTask(task)

  const accountIds = s.accountIds || []
  if (!accountIds.length) {
    task.status = 'error'
    await store.appendLog(task, 'error', 'Нужен хотя бы один аккаунт')
    await store.saveTask(task)
    return
  }

  const wantGroups = kind === 'parsing-groups'
  const unitLabel = wantGroups ? 'групп' : 'каналов'
  const resultKind = wantGroups ? 'group' : 'channel'
  const baseChannels = [] // копим найденное для общей базы каналов (§3.8), упсерт батчем в конце
  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)

  const minMembers = Math.max(0, Number(s.minMembers ?? 0) || 0)
  const maxMembers = Math.max(0, Number(s.maxMembers ?? 0) || 0)
  const rawLimit = Number(s.resultLimit ?? s.limit ?? 0) || 0
  const limit = rawLimit > 0 ? rawLimit : Infinity
  const comments = Number(s.commentFilter ?? 0) || 0 // 0 любые / 1 открытые / 2 закрытые
  const reqFrom = s.delays?.request?.[0] ?? 2
  const reqTo = s.delays?.request?.[1] ?? reqFrom
  const chFrom = s.delays?.channel?.[0] ?? 1
  const chTo = s.delays?.channel?.[1] ?? chFrom

  // Собираем поисковые запросы: ключевые слова + комбинации с окончаниями.
  // Каждый запрос помнит индекс исходного ключевого слова (для AND-пересечения §3.8).
  const keywords = (s.keywords || []).map((k) => String(k).trim()).filter(Boolean)
  const endings = (s.endings || []).map((e) => String(e).trim()).filter(Boolean)
  const andMode = !!s.intersect && keywords.length > 1 // §3.8: канал должен совпасть со ВСЕМИ ключами
  // channelKey → Set<индекс ключевого слова> (для AND). ВОССТАНАВЛИВАЕМ из задачи:
  // при «Продолжить» ранние запросы не переигрываются (курсор их пропускает), и без
  // сохранённой карты финальное AND-пересечение выбросило бы всё, собранное до паузы.
  const hitsByKey = restoreHits(task.hitsByKey)
  // Сериализация карты в задачу перед каждым сохранением — иначе пауза теряет хиты.
  const syncHits = () => { if (andMode) task.hitsByKey = serializeHits(hitsByKey) }
  const queries = []
  const seenQuery = new Set()
  const pushQuery = (q, kwIdx) => { const v = q.trim(); if (v && !seenQuery.has(v.toLowerCase())) { seenQuery.add(v.toLowerCase()); queries.push({ q: v, kwIdx }) } }
  keywords.forEach((kw, kwIdx) => {
    pushQuery(kw, kwIdx)
    for (const end of endings) pushQuery(`${kw} ${end}`, kwIdx)
  })
  if (!queries.length) {
    task.status = 'error'
    await store.appendLog(task, 'error', 'Укажите хотя бы одно ключевое слово')
    await store.saveTask(task)
    return
  }

  const seen = new Set() // дедуп по id/username
  // При продолжении восстанавливаем дедуп из уже собранного, иначе те же каналы
  // приедут повторно и результаты задвоятся.
  for (const r of task.results || []) {
    if (r?.username) seen.add(String(r.username).toLowerCase())
    if (r?.id) seen.add(String(r.id))
  }
  const skipParsed = new Set((s.alreadyParsed || []).map((x) => String(x).toLowerCase()))
  let accIdx = 0

  async function nextAccountId() {
    for (let i = 0; i < accountIds.length; i++) {
      const id = accountIds[accIdx++ % accountIds.length]
      const meta = await accountMeta(id)
      if (canModuleUseAccount(task.moduleKey, meta.status || 'active')) return id
    }
    return null
  }

  const startFrom = Math.min(Number(task.cursor) || 0, queries.length)
  await store.appendLog(
    task,
    'info',
    startFrom > 0
      ? `Парсинг продолжен с запроса ${startFrom + 1} из ${queries.length} · уже собрано: ${task.results.length}`
      : `Парсинг запущен · запросов: ${queries.length} · аккаунтов: ${accountIds.length}`,
  )

  // Пересечение (AND) применяется в КОНЦЕ, когда собраны все ключи. Пока идёт сбор,
  // в результатах видно промежуточное — и это читается как «фильтр не работает»
  // (живая обратная связь заказчика: «якось криво він працює»). Предупреждаем сразу.
  if (andMode) {
    await store.appendLog(
      task,
      'info',
      `Пересечение (AND) по ${keywords.length} ключам применится В КОНЦЕ, когда пройдут все запросы. `
      + 'До этого в результатах видно промежуточный сбор — часть строк уйдёт, деньги за них вернутся.',
    )
  }

  try {
    for (let qi = startFrom; qi < queries.length; qi++) {
      const { q, kwIdx } = queries[qi]
      // В AND-режиме нельзя рано выходить по лимиту — нужно просканировать все ключи для пересечения.
      if (task.stopRequested || task.pauseRequested || (!andMode && task.results.length >= limit)) break
      // Курсор двигаем ДО обработки: если задачу поставят на паузу внутри запроса,
      // при продолжении он не выполнится дважды.
      task.cursor = qi + 1

      const accountId = await nextAccountId()
      if (!accountId) {
        await store.appendLog(task, 'warning', 'Нет доступных аккаунтов (все в карантине/невалидны)')
        break
      }
      const meta = await accountMeta(accountId)
      let client
      try {
        ;({ client } = await connectAccount(accountId, task.id, { shouldStop: stopFlag(task) }))
        const found = await searchPublicDetailed(client, q, 50)
        let added = 0
        for (const c of found) {
          if (task.stopRequested || task.pauseRequested || (!andMode && task.results.length >= limit)) break

          // тип: канал vs группа
          if (wantGroups) { if (c.isBroadcast && !c.isMegagroup) continue }
          else if (!c.isBroadcast) continue

          const key = (c.username || c.id).toLowerCase()
          if (!key) continue
          if (skipParsed.has(key)) continue

          // фильтр комментариев: открытые = мегагруппа/есть обсуждение, закрытые = обычный канал
          if (comments === 1 && c.isBroadcast && !c.isMegagroup) continue
          if (comments === 2 && c.isMegagroup) continue

          // §3.8 AND: отмечаем совпадение ключа — даже если канал уже добавлен другим ключом.
          if (andMode) { let set = hitsByKey.get(key); if (!set) { set = new Set(); hitsByKey.set(key, set) } set.add(kwIdx) }
          if (seen.has(key)) continue

          // число участников (обогащаем через GetFullChannel если поиск не отдал)
          let members = c.members
          if (!members) {
            members = await getChannelMembersCount(client, c.entity)
            await sleep(pickDelay(chFrom, chTo, mul) * 1000)
          }
          if (minMembers && members < minMembers) continue
          if (maxMembers && members > maxMembers) continue

          seen.add(key)
          task.results.push({
            id: c.id,
            title: c.title,
            username: c.username,
            members,
            kind: resultKind,
            link: c.username ? `https://t.me/${c.username}` : '',
            hasComments: !!c.isMegagroup,
          })
          // §3.8/§4: копим для общей базы — упсертим одним батчем в конце (без дублей).
          baseChannels.push({ title: c.title, username: c.username, subscribers: members, hasComments: !!c.isMegagroup, tgPeerId: c.id })
          added += 1
          task.progress.actionsDone = task.results.length
          task.progress.done = task.results.length
          await chargeCollected(task, store)
          task.progress.total = Math.max(task.results.length, task.progress.total || 0)
          syncHits()
          await store.saveTask(task)
        }
        await store.appendLog(task, added ? 'success' : 'info', `«${q}» → +${added} ${unitLabel} (всего ${task.results.length})`, meta.name)
        await disconnectAccount(client, accountId)
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        else endAccountWork(accountId, task.id) // подключение сорвалось — слот занятости не держим
        if (!(await handleFlood(task, accountId, store, err, s, meta.name))) {
          await store.appendLog(task, 'error', `«${q}»: ${mapTelegramError(err)}`, meta.name)
        }
      }

      task = (await store.loadTask(task.id)) || task
      // Диск — источник истины после reload (там могли выставить pause/stop). Наши
      // хиты мы туда только что записали через syncHits, так что карта не отстаёт.
      for (const [k, v] of restoreHits(task.hitsByKey)) hitsByKey.set(k, v)
      await sleep(pickDelay(reqFrom, reqTo, mul) * 1000)
    }

    // §3.8 AND-пересечение: оставляем только каналы, совпавшие со ВСЕМИ ключевыми
    // словами. ТОЛЬКО на завершении, не на паузе: на паузе сбор ещё частичный, и
    // пересечение вычеркнуло бы каналы, чьи остальные ключи придут после «Продолжить»,
    // — а курсор их уже не переиграет, и они пропали бы навсегда (карту хитов мы
    // сохраняем, но сами строки удалять рано).
    if (andMode && !task.stopRequested && !task.pauseRequested) {
      const need = keywords.length
      const before = task.results.length
      task.results = keepIntersecting(task.results, hitsByKey, need, limit)
      const keepSet = new Set(task.results.map((r) => (r.username || r.id).toLowerCase()))
      for (let i = baseChannels.length - 1; i >= 0; i--) {
        if (!keepSet.has((baseChannels[i].username || baseChannels[i].tgPeerId || '').toString().toLowerCase())) baseChannels.splice(i, 1)
      }
      await store.appendLog(task, 'info', `AND-пересечение (${need} ключей): ${before} → ${task.results.length}`)
    }

    task.progress.total = task.results.length
    task.progress.done = task.results.length
    task.progress.actionsDone = task.results.length
    // Хвост: то, что докопилось после последнего списания в цикле сбора,
    // и возврат за строки, которые срезали фильтры (AND-пересечение, чёрный список).
    await chargeCollected(task, store)
    await refundShrunk(task, store)
    task.status = statusAfterRun(task)
    // Курсор нужен только между паузой и продолжением. На завершении/стопе сбрасываем,
    // иначе «Перезапуск» начал бы с конца очереди и не сделал бы ничего.
    if (task.status !== 'paused') { task.cursor = 0; delete task.hitsByKey }
    // §3.8/§4: найденные каналы — в общую базу одним батчем (дедуп, без потери данных).
    try { const n = await upsertMany(baseChannels, `parse:${task.id}`); if (n) await store.appendLog(task, 'info', `В базу каналов: ${n}`) } catch { /* ignore */ }
    // §6 (MR-38): завершённый сбор — в кэш результатов под сигнатуру запроса, чтобы
    // повтор того же поиска отдавался из базы с датой, без нового прохода по аккаунтам.
    // Только на 'done' (не пауза/стоп — там сбор частичный) и вне горячего цикла.
    if (task.status === 'done') {
      // Динамический импорт (как payments.js): parserCache тянет node:sqlite, и если он
      // в этой среде недоступен — падает только кэш (в catch), а не загрузка воркеров.
      try { const { saveParserResults } = await import('../parserCache.js'); await saveParserResults(kind, s, task.results) } catch { /* кэш необязателен — молча */ }
    }
    await store.appendLog(task, 'info', `Готово · найдено ${task.results.length} ${unitLabel}`)
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
}

const mapUser = (u) => ({
  id: u?.id?.toString?.() ?? '',
  name: `${u?.firstName || ''} ${u?.lastName || ''}`.trim() || u?.username || (u?.id?.toString?.() ?? '—'),
  username: u?.username || '',
  bot: !!u?.bot,
  premium: !!u?.premium,
  hasPhoto: !!u?.photo,
  deleted: !!u?.deleted,
  scam: !!(u?.scam || u?.fake),
})

/**
 * Парсер участников: пользователи из групп / по сообщениям / из комментариев.
 * Мульти-цели, ротация аккаунтов, фильтры (боты/удалённые/scam/username/фото/premium/админы),
 * лимиты, ключевые слова, задержки, дедуп по id.
 * @param {object} task @param {object} store @param {'parsing-users'|'parsing-messages'|'parsing-comments'} kind
 */
export async function runParticipantsParser(task, store, kind) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  task.results = []
  await store.saveTask(task)

  const accountIds = s.accountIds || []
  if (!accountIds.length) {
    task.status = 'error'
    await store.appendLog(task, 'error', 'Нужен хотя бы один аккаунт')
    await store.saveTask(task)
    return
  }

  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const F = s.filters || {}
  const L = s.limits || {}
  const kw = (s.keywords || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean)
  // §3.9: аккаунты идут ОДНОВРЕМЕННО внутри одной задачи, каждый по своим целям.
  const parallelAccounts = s.parallelAccounts === true
  const delayChatMs = Math.max(0, Number(s.delayChat ?? 15)) * 1000
  const delayItemMs = Math.max(0, Number(s.delayItem ?? 0.5)) * 1000
  // Вступление — самое опасное действие: чтобы прочитать участников чужого чата,
  // аккаунт сначала должен в него ВОЙТИ, а серия быстрых вступлений даёт FloodWait
  // и попадание в спам-фильтр. Задержки «между чатами» тут мало: она срабатывает
  // ПОСЛЕ обработки, а вступления идут подряд. Поэтому отдельная пауза перед join,
  // как в остальных модулях (§6).
  const joinDelay = pickJoinDelay(s.delays?.join?.[0] ?? 90, s.delays?.join?.[1] ?? 240, mul)
  task.readyTargets = task.readyTargets || [] // куда аккаунт уже вступал — второй раз не ждём
  const tgs = targets(s)
  if (!tgs.length) {
    task.status = 'error'
    await store.appendLog(task, 'error', 'Укажите хотя бы один источник (группу/канал/чат)')
    await store.saveTask(task)
    return
  }

  const passUser = (u) => {
    if (F.skipBots && u.bot) return false
    if (F.skipDeleted && u.deleted) return false
    if (F.skipScam && u.scam) return false
    if (F.onlyUsername && !u.username) return false
    if (F.onlyPhoto && !u.hasPhoto) return false
    if (F.onlyPremium && !u.premium) return false
    return true
  }
  const seen = new Set()
  // Пересечение аудиторий (только parsing-users): пользователь засчитывается, если встречается
  // минимум в intersectionMin группах (по умолчанию — во всех выбранных).
  const intersection = kind === 'parsing-users' && !!s.intersectionMode && tgs.length > 1
  const intersectMin = intersection ? (Number(s.intersectionMin) > 0 ? Number(s.intersectionMin) : tgs.length) : 0
  const userHits = new Map() // id -> { user, hits }
  let accIdx = 0
  const nextAccountId = async () => {
    for (let i = 0; i < accountIds.length; i++) {
      const id = accountIds[accIdx++ % accountIds.length]
      const meta = await accountMeta(id)
      if (canModuleUseAccount(task.moduleKey, meta.status || 'active')) return id
    }
    return null
  }

  let processed = 0
  task.progress.total = tgs.length
  task.progress.actionsDone = 0
  task.progress.done = 0
  await store.saveTask(task)
  await store.appendLog(task, 'info', `Парсинг участников: источников ${tgs.length}, аккаунтов ${accountIds.length}${intersection ? ` · режим пересечения (≥${intersectMin} групп)` : ''}`)

  try {
    /** Проход ОДНОГО аккаунта по своему набору целей. Тело осталось прежним. */
    const runSlice = async (slice, pinnedId) => {
    for (const src of slice) {
      if (task.stopRequested) break
      const accountId = pinnedId || await nextAccountId()
      if (!accountId) { await store.appendLog(task, 'warning', 'Нет доступных аккаунтов'); break }
      const meta = await accountMeta(accountId)
      let client
      try {
        ;({ client } = await connectAccount(accountId, task.id, { shouldStop: stopFlag(task) }))
        // Вступление — крайняя мера. У публичных групп и каналов участники и сообщения
        // часто читаются БЕЗ вступления: сначала пробуем просто разрешить цель и работать
        // с ней. Если Telegram откажет — тогда вступаем, с паузой.
        let peerNoJoin = null
        try {
          const { resolvePeer } = await import('../lib/gramHelpers.js')
          peerNoJoin = await resolvePeer(client, src)
        } catch { /* не разрешилось — пойдём обычным путём со вступлением */ }

        // Пробы «а вдруг откроется» здесь НЕТ намеренно. Раньше на каждую цель уходило
        // два GetParticipants: пробный и основной. Метод жёстко лимитирован, на каналах
        // оба заведомо падают — это и был главный источник FloodWait 21.07. Основной
        // вызов ниже сам сообщит, что список закрыт, и мы просто пойдём дальше.
        let membership = peerNoJoin ? { peer: peerNoJoin, status: 'no_join_needed' } : null
        if (!membership) membership = await prepareTarget(
          client,
          src,
          (l, m, a) => store.appendLog(task, l, m, a),
          meta.name,
          joinDelay,
          task.readyTargets,
          accountId,
          makeStopCheck(store, task.id),
        )
        if (!membership?.peer) { await disconnectAccount(client, accountId); continue }
        const peer = membership.peer
        let added = 0

        // §3.9: собираем ОБОИМИ способами — список участников и тех, кто писал.
        // Списки участников у крупных каналов закрыты или обрезаны, а «писавшие» дают
        // только активных: по отдельности каждый способ теряет часть людей. `seen`
        // общий, поэтому пересечение схлопывается и дублей не будет.
        if (kind === 'parsing-users') {
          // Режим «Активные»: канал → находим чат обсуждения → парсим тех, кто писал,
          // разбивая на админ/премиум/обычный.
          let chatPeer = peer
          // Сначала штатная привязанная дискуссия (она же вступает, если надо).
          try { const disc = await joinDiscussionGroupIfNeeded(client, peer); if (disc?.peer) { chatPeer = disc.peer; await store.appendLog(task, 'info', `${src}: найден чат обсуждения`, meta.name) } } catch { /* ищем другими способами ниже */ }
          // Если привязки нет — чат может быть спрятан в описании или в подписи постов.
          if (chatPeer === peer && isChannelPeer(peer)) {
            const { Api } = await import('telegram/tl/index.js')
            const found = await findChannelChat(client, peer, {
              getFull: (p) => client.invoke(new Api.channels.GetFullChannel({ channel: p })),
              resolve: (name) => client.getEntity(name),
              getMessages: (p, o) => client.getMessages(p, o),
              postsToScan: 3,
            })
            if (found) {
              chatPeer = found.peer
              const how = { about: 'в описании канала', posts: 'в подписи последних постов' }[found.via] || 'по ссылке'
              await store.appendLog(task, 'info', `${src}: чат найден ${how}`, meta.name)
            }
          }
          // Чата нет: у канала пишет только администрация, и «активные» превратятся
          // в одного автора — тот самый мусорный «+1» на 132 целях из 148 (21.07).
          if (chatPeer === peer && isChannelPeer(peer)) {
            await store.appendLog(task, 'warning', `${src}: у канала нет чата — парсить некого, пропуск`, meta.name)
            await disconnectAccount(client, accountId)
            continue
          }
          // множество админов для категоризации
          let adminIds = new Set()
          try { const admins = await fetchParticipants(client, chatPeer, 200, { adminsOnly: true }); adminIds = new Set(admins.map((a) => a.id)) } catch { /* нет прав/список закрыт */ }
          const messages = await client.getMessages(chatPeer, { limit: L.messages || L.participants || 1000 })
          const bySender = new Map()
          for (const m of messages) {
            if (!m?.senderId) continue
            const sid = m.senderId.toString()
            const rec = bySender.get(sid) || { count: 0, sender: m.sender }
            rec.count++; if (!rec.sender && m.sender) rec.sender = m.sender
            bySender.set(sid, rec)
          }
          for (const [sid, rec] of bySender) {
            if (task.stopRequested || seen.has(String(sid))) continue
            const u = rec.sender ? mapUser(rec.sender) : { id: sid, name: sid, username: '', bot: false }
            if (!passUser(u)) continue
            const role = adminIds.has(sid) ? 'admin' : (u.premium ? 'premium' : 'user')
            if (F.onlyAdmins && role !== 'admin') continue
            seen.add(String(sid))
            task.results.push({ ...u, kind: 'user', source: src, messagesCount: rec.count, role })
            added++
          }
        }
        if (kind === 'parsing-users') {
          let users = []
          try {
            users = await fetchParticipants(client, peer, L.participants || s.limit || 1000, { adminsOnly: !!F.onlyAdmins })
          } catch (e) {
            const msg = mapTelegramError(e)
            if (/ADMIN_REQUIRED|CHAT_ADMIN|CHANNEL_PRIVATE|not.*visible/i.test(msg)) {
              // Не тупик: писавших мы уже собрали выше, просто список участников недоступен.
              await store.appendLog(task, 'info', `${src}: список участников закрыт — взяли только тех, кто писал`, meta.name)
            } else { throw e }
          }
          const seenInThisTarget = new Set()
          for (const u of users) {
            if (task.stopRequested) break
            if (!u.id || !passUser(u)) continue
            if (intersection) {
              // считаем вхождение пользователя в каждую группу не более одного раза
              if (seenInThisTarget.has(u.id)) continue
              seenInThisTarget.add(u.id)
              const rec = userHits.get(u.id) || { user: u, hits: 0 }
              rec.hits++; rec.user = rec.user || u
              userHits.set(u.id, rec)
              added++
            } else {
              if (seen.has(String(u.id))) continue
              seen.add(String(u.id))
              task.results.push({ ...u, kind: 'user', source: src })
              added++
            }
          }
        } else if (kind === 'parsing-messages') {
          const days = Number(L.days || 0)
          const minDate = days ? Math.floor(Date.now() / 1000) - days * 86400 : 0
          const messages = await client.getMessages(peer, { limit: L.messages || 1000 })
          const bySender = new Map()
          for (const m of messages) {
            if (!m?.senderId) continue
            if (minDate && m.date && m.date < minDate) continue
            if (!F.includeForwarded && m.fwdFrom) continue
            const text = m.message || ''
            if (kw.length && !kw.some((k) => text.toLowerCase().includes(k))) continue
            const sid = m.senderId.toString()
            const rec = bySender.get(sid) || { count: 0, first: m.date, last: m.date, sender: m.sender }
            rec.count++; rec.first = Math.min(rec.first, m.date); rec.last = Math.max(rec.last, m.date)
            if (!rec.sender && m.sender) rec.sender = m.sender
            bySender.set(sid, rec)
          }
          for (const [sid, rec] of bySender) {
            if (task.stopRequested || seen.has(String(sid))) continue
            const u = rec.sender ? mapUser(rec.sender) : { id: sid, name: sid, username: '', bot: false }
            if (!passUser(u)) continue
            seen.add(String(sid))
            task.results.push({ ...u, kind: 'user', source: src, messagesCount: rec.count, firstSeen: new Date(rec.first * 1000).toISOString(), lastSeen: new Date(rec.last * 1000).toISOString() })
            added++
          }
        } else if (kind === 'parsing-comments') {
          const minLen = Number(L.minCommentLen || 0)
          const posts = await fetchPosts(client, peer, L.posts || 50)
          for (const post of posts) {
            if (task.stopRequested) break
            let comments = []
            try { comments = await client.getMessages(peer, { replyTo: post.id, limit: L.commentsPerPost || 100 }) } catch { comments = [] }
            for (const c of comments) {
              if (!c?.senderId) continue
              const text = c.message || ''
              if (minLen && text.length < minLen) continue
              if (kw.length && !kw.some((k) => text.toLowerCase().includes(k))) continue
              const sid = c.senderId.toString()
              if (seen.has(sid)) continue
              const u = c.sender ? mapUser(c.sender) : { id: sid, name: sid, username: '', bot: false }
              if (!passUser(u)) continue
              seen.add(String(sid))
              task.results.push({ ...u, kind: 'user', source: src, ...(F.keepText ? { commentText: text.slice(0, 300) } : {}) })
              added++
            }
            if (delayItemMs) await sleep(delayItemMs)
          }
        }

        await store.saveTask(task)
        await store.appendLog(task, added ? 'success' : 'info', `${src}: +${added} (всего ${task.results.length})`, meta.name)
        await disconnectAccount(client, accountId)
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        else endAccountWork(accountId, task.id) // подключение сорвалось — слот занятости не держим
        const flooded = await handleFlood(task, accountId, store, err, s, meta.name)
        if (!flooded) {
          await store.appendLog(task, 'error', `${src}: ${mapTelegramError(err)}`, meta.name)
        } else if (pinnedId) {
          // Аккаунт получил FloodWait. Пробовать им дальше — значит удлинять наказание:
          // Telegram считает попытки, а не успехи. В асинхронном режиме у аккаунта свой
          // набор целей, поэтому останавливаем именно его поток, остальные идут дальше.
          // Недоделанные цели этого аккаунта НЕ теряем: складываем в общую очередь,
          // её доберут живые потоки, закончив своё. Раньше они пропадали безвозвратно —
          // при пяти аккаунтах один FloodWait уносил пятую часть парсинга (аудит 20.08).
          const left = slice.slice(slice.indexOf(src) + 1)
          if (left.length) orphanTargets.push(...left)
          await store.appendLog(
            task, 'warning',
            `${meta.name}: FloodWait — поток остановлен${left.length ? `, ${left.length} цел(ей) вернули в очередь` : ''}`,
            meta.name,
          )
          break
        }
      }
      // прогресс — по обработанным группам (а не по числу результатов)
      task = (await store.loadTask(task.id)) || task
      processed++
      task.progress.total = tgs.length
      task.progress.actionsDone = processed
      task.progress.done = processed
      await store.saveTask(task)
      if (!task.stopRequested) await sleep(delayChatMs || pickDelay(3, 6, mul) * 1000)
    }
    }

    // Цели, осиротевшие из-за FloodWait чужого потока. Живой поток забирает их себе,
    // когда разберётся со своими: parallel-режим иначе просто терял эту часть работы.
    const orphanTargets = []

    if (parallelAccounts && accountIds.length > 1) {
      // Цели по кругу между аккаунтами, чтобы нагрузка легла ровно.
      const slices = accountIds.map(() => [])
      tgs.forEach((t, idx) => slices[idx % accountIds.length].push(t))
      await store.appendLog(task, 'info', `Асинхронный режим: ${accountIds.length} аккаунтов идут одновременно, старт вразнобой`)
      await Promise.all(accountIds.map(async (id, idx) => {
        if (!slices[idx].length) return
        // Разбег стартов: одновременный залп — это и есть то, что Telegram видит как
        // ферму. Пауза случайная, а не кратная, чтобы не было машинного ритма.
        if (idx > 0) {
          // Разбег берём из тех же настроек join, что и пауза перед вступлением:
          // отдельных переменных здесь нет — раньше я сослался на несуществующие.
          const lagFrom = Number(s.delays?.join?.[0]) || 20
          const lagTo = Math.max(lagFrom, Number(s.delays?.join?.[1]) || 90)
          const lag = Math.round(pickDelay(lagFrom, lagTo, mul) * 1000 * (0.5 + Math.random()))
          await store.appendLog(task, 'info', `Аккаунт ${idx + 1}: старт через ${Math.round(lag / 1000)}с`)
          if (await interruptibleSleep(lag, makeStopCheck(store, task.id))) return
        }
        await runSlice(slices[idx], id)
        // Свои цели кончились — подбираем чужие, брошенные из-за FloodWait.
        while (orphanTargets.length) {
          const fresh = await store.loadTask(task.id).catch(() => null)
          if (fresh?.stopRequested || fresh?.pauseRequested) break
          const take = orphanTargets.splice(0, orphanTargets.length)
          await store.appendLog(task, 'info', `Аккаунт ${idx + 1} добирает ${take.length} цел(ей) из брошенных`)
          await runSlice(take, id)
        }
      }))
    } else {
      await runSlice(tgs, null)
    }

    // Финализация пересечения: оставляем только тех, кто встретился в >= intersectMin группах.
    if (intersection) {
      task.results = []
      for (const { user, hits } of userHits.values()) {
        if (hits >= intersectMin) task.results.push({ ...user, kind: 'user', source: (user.sources || []).join(', '), groupsCount: hits })
      }
      task.results.sort((a, b) => (b.groupsCount || 0) - (a.groupsCount || 0))
      await store.appendLog(task, 'info', `Пересечение: ${task.results.length} пользователей в ≥${intersectMin} из ${tgs.length} групп`)
    }

    task.progress.total = tgs.length
    task.progress.actionsDone = processed
    task.progress.done = processed
    task.status = statusAfterRun(task)
    // §6 (MR-38): собранная аудитория — в кэш под сигнатуру запроса (источники + фильтры
    // + лимиты сбора). Раньше кэшировался только поиск каналов, и повторный парс той же
    // группы каждый раз заново гонял аккаунты. Только на 'done': пауза и стоп дают
    // частичный сбор, выдавать его за готовый результат нельзя.
    if (task.status === 'done') {
      try { const { saveParserResults } = await import('../parserCache.js'); await saveParserResults(kind, s, task.results) } catch { /* кэш необязателен — молча */ }
    }
    await store.appendLog(task, 'info', `Готово · обработано ${processed}/${tgs.length} групп · найдено ${task.results.length} пользователей`)
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
}

/**
 * Мейлинг: реальная рассылка в Telegram по номерам телефонов (§8.4).
 * Отправка НЕ «слепая»: жёсткие предохранители §6 — только аккаунты с trust>70, суточный
 * лимит ЛС (dm), паузы 90–300с, пропуск номеров, которых нет в Telegram, FloodWait→карантин.
 * Номер резолвим через contacts.ImportContacts, шлём ЛС (шаблон или ИИ-текст к цели).
 * @param {object} task @param {object} store
 */
/** §11: тип вложения по URL (зеркало фронтового mediaKind). */
function mediaKindUrl(url) {
  const u = String(url).toLowerCase().split('?')[0]
  if (/\.(jpe?g|png|webp|gif|bmp|heic)$/.test(u)) return 'image'
  if (/\.(mp4|mov|webm|mkv|avi|m4v)$/.test(u)) return 'video'
  return 'link'
}

/**
 * §11: отправка сообщения с медиа и Markdown-форматированием.
 * Фото/видео (по URL) шлём как файлы с подписью; прочие ссылки добавляем в текст.
 * Markdown — с фолбеком на обычный текст, если разметка малформед.
 * @param {import('telegram').TelegramClient} client
 */
async function sendComposedMessage(client, peer, text, mediaUrls = []) {
  const urls = (Array.isArray(mediaUrls) ? mediaUrls : []).filter((u) => /^https?:\/\//i.test(u))
  const files = urls.filter((u) => mediaKindUrl(u) !== 'link')
  const links = urls.filter((u) => mediaKindUrl(u) === 'link')
  const caption = [text, ...links].filter(Boolean).join('\n')

  const sendText = async (msg) => {
    try { await client.sendMessage(peer, { message: msg, parseMode: 'md', linkPreview: true }) }
    catch { await client.sendMessage(peer, { message: msg }) } // малформед markdown → плейн-текст
  }

  if (files.length) {
    try {
      await client.sendFile(peer, { file: files, caption, parseMode: 'md' })
      return
    } catch {
      // Файлы недоступны по URL — шлём текст со всеми ссылками (Telegram сделает превью).
      await sendText([text, ...urls].filter(Boolean).join('\n'))
      return
    }
  }
  await sendText(caption)
}

export async function runMailing(task, store) {
  const s = task.settings || {}
  const accountIds = Array.isArray(s.accountIds) ? s.accountIds : []
  // §8.4: цель рассылки — номер ИЛИ юзернейм. Раньше принимались только номера,
  // а юзернеймы молча превращались в чужие номера (из строки вырезались цифры).
  // Чёрный список действует и на рассылку. Раньше он применялся только к каналам и
  // группам (через `targets()`), а получатели мейлинга шли мимо — то есть человеку,
  // которого явно занесли в ЧС, спокойно уходило личное сообщение. Это худшее место
  // для такой дыры: в ЛС «больше не пишите» означает жалобу, а не просто отписку.
  const allMailTargets = classifyMailingTargets(s.targets)
  const mailTargets = allMailTargets.filter((t) => !isBlacklistedMailingTarget(t.kind, t.value))
  const blacklisted = allMailTargets.length - mailTargets.length
  const phonesCount = mailTargets.filter((t) => t.kind === 'phone').length
  const handlesCount = mailTargets.length - phonesCount
  const message = String(s.promptText || s.message || '').trim()

  task.status = 'running'
  task.progress = { done: 0, total: mailTargets.length }
  task.accountStats = task.accountStats || {}
  await store.saveTask(task)
  await store.appendLog(task, 'info', `Мейлинг: ${mailTargets.length} целей (номеров ${phonesCount}, юзернеймов ${handlesCount}) на ${accountIds.length} аккаунт(ов)`)
  // Сколько отсеял ЧС — отдельной строкой: молчаливое сокращение списка выглядит
  // как потеря получателей, и оператор идёт искать несуществующий баг.
  if (blacklisted) await store.appendLog(task, 'info', `Чёрный список: исключено получателей — ${blacklisted}`)

  if (!mailTargets.length) { await store.appendLog(task, 'warning', 'Нет корректных целей для рассылки'); task.status = 'done'; await store.saveTask(task); return }
  if (!accountIds.length) { await store.appendLog(task, 'warning', 'Не выбраны аккаунты'); task.status = 'done'; await store.saveTask(task); return }
  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const dm = s.delays?.dm || s.delays?.action || [90, 300] // §6: паузы рассылки ЛС 90–300с
  const maxPerAccount = Number(s.maxPerAccount || 0)
  const goalCtx = await buildGoalContext(s.goalId)
  // A3.3: тон, роль и запреты берём у АГЕНТА задачи, а не у цели (SPEC §1.2).
  // Пустая строка, если агент не выбран — генерация работает как раньше.
  const agentCtx = await buildAgentContext(s.agentId)
  // Дожим тоже принадлежит агенту: «дожимать или отпускать» — манера общения.
  // Для задач без агента остаётся цель — старые кампании продолжают работать.
  const agentObj = s.agentId ? await getAgent(s.agentId).catch(() => null) : null
  // Заготовки первого сообщения теперь живут у АГЕНТА (24.07): «как заговорить первым» —
  // свойство персоны, а не измеримого результата. Варианты в поле `firstMessage` агента,
  // разделены пустой строкой; чередуем по кругу. Для СТАРЫХ целей, где текст лежал в
  // описании цели («Первое сообщение:»), оставлен fallback — их не ломаем.
  const goalOpeners = await (async () => {
    const { splitMessageVariants, firstMessagesFromGoal } = await import('../lib/goalContext.js')
    const fromAgent = splitMessageVariants(agentObj?.firstMessage)
    if (fromAgent.length) {
      await store.appendLog(task, 'info', `Первое сообщение из агента: ${fromAgent.length} вариант(ов), чередуем`)
      return fromAgent
    }
    if (!s.goalId) return []
    try {
      const { getGoal } = await import('../goals.js')
      const legacy = firstMessagesFromGoal(await getGoal(s.goalId))
      if (legacy.length) await store.appendLog(task, 'info', `Первое сообщение из цели (устар.): ${legacy.length} вариант(ов), чередуем`)
      return legacy
    } catch { return [] }
  })()
  const useAi = !!s.aiPerRecipient && isAiGenerationEnabled()
  // Пустой текст — не повод останавливаться: заготовка может лежать в самой цели
  // («Первое сообщение:» в описании) или текст сгенерит ИИ к цели.
  if (!message && !goalOpeners.length && !useAi) {
    await store.appendLog(task, 'warning', 'Нет текста: задайте его в модуле или в цели («Первое сообщение:»)')
    task.status = 'done'; await store.saveTask(task); return
  }

  const mediaCount = Array.isArray(s.mediaUrls) ? s.mediaUrls.filter((u) => /^https?:\/\//i.test(u)).length : 0
  await store.appendLog(task, 'info', `Текст: ${useAi ? 'ИИ-генерация к цели' : `"${message.slice(0, 70)}${message.length > 70 ? '…' : ''}"`}${mediaCount ? ` · медиа/ссылок: ${mediaCount}` : ''} · паузы ${dm[0]}–${dm[1]}с · лимит/акк ${maxPerAccount || '§6'}`)

  const { Api } = await import('telegram/tl/index.js')
  const { default: bigInt } = await import('big-integer')
  const { buildAccountStats } = await import('../accountStats.js')

  // Предохранитель §6: рассылка только с прогретых аккаунтов. Порог настраиваемый —
  // он зависит от того, какие аккаунты закупаются (у спам-аккаунтов trust низкий по
  // определению), поэтому это настройка, а не константа.
  const { getSetting } = await import('../settings.js')
  const minTrust = Number(await getSetting('mailingMinTrust')) || 0
  // Админ может осознанно пустить аккаунты ниже порога — тогда это не тихий обход,
  // а явный флаг задачи, и он попадает в лог.
  const allowLowTrust = s.allowLowTrust === true

  const usable = []
  const lowTrust = []
  for (const id of accountIds) {
    const meta = await accountMeta(id)
    if (!canModuleUseAccount(task.moduleKey, meta.status || 'active')) { await store.appendLog(task, 'warning', `Пропуск: статус ${meta.status}`, meta.name); continue }
    let trust = 0
    try { trust = (await buildAccountStats(id)).trust?.score ?? 0 } catch { trust = 0 }
    if (trust < minTrust) {
      if (!allowLowTrust) {
        await store.appendLog(task, 'warning', `${meta.name}: trust ${trust} < ${minTrust} — пропущен (§6: порог рассылки)`, meta.name)
        continue
      }
      lowTrust.push(`${meta.name} (${trust})`)
    }
    usable.push(id)
  }
  if (!usable.length) {
    await store.appendLog(task, 'warning', `Нет аккаунтов с trust ≥ ${minTrust} — рассылка не запущена (§6). Прогрейте аккаунты или снизьте порог в настройках.`)
    task.status = 'done'; await store.saveTask(task); return
  }
  if (lowTrust.length) {
    await store.appendLog(task, 'warning', `Админ разрешил рассылку с ${lowTrust.length} аккаунтов ниже порога ${minTrust}: ${lowTrust.slice(0, 5).join(', ')}${lowTrust.length > 5 ? '…' : ''}`)
  }
  await store.appendLog(task, 'info', `К рассылке допущено аккаунтов: ${usable.length}/${accountIds.length} (порог trust ${minTrust}${allowLowTrust ? ', разрешён обход' : ''})`)

  let sent = 0
  let skipped = 0
  const perAccSent = {}

  try {
    /** Один ПОТОК рассылки: свои цели и свои аккаунты, независимо от остальных. */
    const runThread = async (myTargets, myAccounts, threadNo = 0) => {
    let idx = 0
    // Расфазировка: без неё потоки быстро выравниваются и шлют синхронно —
    // это и есть кластер, который видно со стороны.
    if (threadNo > 0) await sleep(Math.round(pickDelay(5, 20, mul) * 1000 * (0.4 + Math.random() * 1.2)))
    /*
     * Очередь, а не фиксированный список: цель, потерянную ПО ВИНЕ АККАУНТА (спамблок,
     * флуд, обрыв), возвращаем в конец и отдаём другому аккаунту потока.
     *
     * Прогон 22.08: аккаунт словил спамблок ровно на отправке — и единственная цель
     * пропала, хотя в потоке было ещё два свободных аккаунта. Задача закрылась словами
     * «отправлено 0», человек в базе остался ненаписанным. В коде ниже про это прямо
     * сказано: «такие цели брать МОЖНО: причина в аккаунте, не в них» — но относилось это
     * только к СЛЕДУЮЩЕЙ рассылке, а внутри текущей цель терялась.
     *
     * Повтор ровно один: если и второй аккаунт не смог, дело, скорее всего, в самой цели.
     */
    const очередь = [...myTargets]
    const повторено = new Set()
    while (очередь.length) {
      const tgt = очередь.shift()
      const phone = tgt.kind === 'phone' ? tgt.value : ''
      const label = tgt.kind === 'phone' ? `+${tgt.value}` : `@${tgt.value}`
      task = (await store.loadTask(task.id)) || task
      if (task.stopRequested || task.pauseRequested || totalLimitReached(s, task)) break

      // Статус проверяем НА КАЖДОМ КРУГЕ, а не один раз на старте: аккаунт уходит в
      // карантин посреди рассылки (handleFlood), и старый код продолжал его выбирать —
      // connectAccount падал с ACCOUNT_SKIP, цель помечалась неудачной и БОЛЬШЕ НЕ
      // повторялась. Один карантинный из пяти съедал пятую часть базы (аудит 20.08).
      for (const cand of [...myAccounts]) {
        const cm = await accountMeta(cand)
        if (!canModuleUseAccount(task.moduleKey, cm.status || 'active')) {
          myAccounts.splice(myAccounts.indexOf(cand), 1)
          await store.appendLog(task, 'warning', `${cm.name || cand}: статус ${cm.status} — выведен из рассылки (осталось ${myAccounts.length})`)
        }
      }
      if (!myAccounts.length) { await store.appendLog(task, 'warning', 'В потоке не осталось рабочих аккаунтов — завершаем'); break }

      // §4.1–§4.3: усталость и распорядок. Рассылка их КОПИЛА (noteAction ниже), но не
      // спрашивала — аккаунт, отработавший смену, продолжал слать холодные ЛС сверх
      // порога, а это самый спамблокоопасный модуль (аудит 20.08). Уставший аккаунт
      // пропускаем на этот круг: цель не теряется, её возьмёт другой аккаунт, а этот
      // вернётся после отдыха.
      const restingNow = []
      for (const cand of [...myAccounts]) {
        const gate = await canWorkNow(cand)
        if (!gate.ok) {
          restingNow.push(cand)
          myAccounts.splice(myAccounts.indexOf(cand), 1)
          const cm = await accountMeta(cand)
          await store.appendLog(task, 'info', `Пропуск: ${gate.reason}`, cm.name || cand)
        }
      }
      if (!myAccounts.length) {
        // Отдыхают ВСЕ — ждать до ближайшего возврата, как это делают карусельные модули.
        // Завершать нельзя: рассылка на тысячу контактов идёт часами и переживёт отдых.
        /*
         * Правка 22.08 (прогон): рассылка завершалась ровно тогда, когда аккаунт
         * ОСВОБОЖДАЛСЯ. Здесь для каждого отдыхающего делался ВТОРОЙ бросок распорядка,
         * и если он выпадал удачно, код писал `backAt = Date.now()` — «вернётся прямо
         * сейчас». Дальше `idleWaitPlan` видел ноль миллисекунд, отвечал «ждать нечего»,
         * и ветка ниже честно завершала задачу словами «все аккаунты недоступны».
         *
         * В логе это выглядело абсурдом: «следующая попытка через 18 с» и сразу
         * «завершаем · отправлено 0». Аккаунт свободен — надо продолжать круг, а не
         * искать, сколько его ждать.
         */
        let backAt = 0
        let свободенСразу = false
        for (const id of restingNow) {
          const g = await canWorkNow(id)
          if (g.ok) { свободенСразу = true; break }
          if (g.until) backAt = backAt ? Math.min(backAt, g.until) : g.until
        }
        if (свободенСразу) {
          myAccounts.push(...restingNow)
          continue
        }
        const plan = idleWaitPlan(backAt)
        if (!plan.wait) { await store.appendLog(task, 'warning', 'Все аккаунты потока недоступны — завершаем'); break }
        await noteWait(task, store, plan.ms, `все аккаунты отдыхают, вернутся в ${new Date(backAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`)
        if (await breakableDelay(plan.ms, store, task)) break
        myAccounts.push(...restingNow)
        continue
      }

      // Выбрать аккаунт round-robin, у которого не исчерпан суточный лимит ЛС и maxPerAccount.
      // dm-лимит асинхронный — предвычисляем множество «исчерпавших» для чистого выбора.
      const dmReached = new Set()
      for (const cand of myAccounts) if (await limitReached(cand, 'dm')) dmReached.add(cand)
      const picked = pickMailingAccount(myAccounts, idx, { perAccSent, maxPerAccount, isDmReached: (id) => dmReached.has(id) })
      const account = picked.account
      idx = picked.idx
      if (!account) { await store.appendLog(task, 'info', 'Все аккаунты исчерпали суточный лимит ЛС (§6) — завершаем'); break }

      const meta = await accountMeta(account)
      let client
      try {
        ;({ client } = await connectAccount(account, task.id, { shouldStop: stopFlag(task) }))
        // 1) Резолв цели → пользователь Telegram. Номер импортируем в контакты,
        // юзернейм разрешаем напрямую — ImportContacts для него бессмыслен.
        let user = null
        if (tgt.kind === 'phone') {
          const res = await client.invoke(new Api.contacts.ImportContacts({
            contacts: [new Api.InputPhoneContact({ clientId: bigInt(idx * 1000 + sent + skipped), phone: `+${phone}`, firstName: 'Lead', lastName: '' })],
          }))
          user = res.users?.[0] || null
        } else {
          try { user = await client.getEntity(tgt.value) } catch { user = null }
        }
        if (!user) {
          skipped += 1
          task.progress.done = sent + skipped
          await store.appendLog(task, 'info', `${label}: нет в Telegram — пропуск`, meta.name)
          // Пропуск тоже в историю: иначе после прогона не отличить «не написали, потому
          // что не дошли» от «не написали, потому что такого человека нет». Первых надо
          // взять в следующую рассылку, вторых — нет.
          await store.appendHistory(task, {
            id: `${task.id}_${Date.now()}`,
            ts: new Date().toISOString(),
            accountName: meta.name || account,
            target: label,
            text: '',
            status: 'skipped',
            reason: 'нет в Telegram',
          })
          await disconnectAccount(client, account)
          continue
        }
        // 2) Текст: шаблон или ИИ к цели.
        let text = message
        // Вариант первого сообщения — свой для каждого получателя, по кругу. Один и тот же
        // текст на всю рассылку Telegram видит как спам-паттерн (прогон 21–22.07: 11 блоков).
        const { pickFirstMessage } = await import('../lib/goalContext.js')
        const opener = goalOpeners.length ? pickFirstMessage(goalOpeners, sent + skipped) : ''
        if (!text && opener) text = opener
        if (useAi) {
          // ВАЖНО: текст шаблона нельзя отдавать как ПРОМПТ — ИИ принимал его за реплику
          // собеседника и писал ОТВЕТ от лица получателя («Да, я интересуюсь трейдингом,
          // какой канал ты хотел бы предложить?»). Нужно явно просить первое сообщение.
          const openerTask = [
            'Напиши ПЕРВОЕ сообщение незнакомому человеку — холодный контакт.',
            'Это ты пишешь первым, собеседник тебе ещё ничего не писал.',
            'Коротко (1–2 предложения), по-человечески, с вопросом в конце.',
            'Не благодари за ответ и не поддакивай — отвечать пока некому.',
            // Образец тоже чередуем: иначе ИИ каждый раз отталкивается от одного текста
            // и выдаёт почти одинаковые сообщения — смысл вариантов теряется.
            (message || opener) ? `Опирайся на этот текст как на образец смысла и тона:
«${message || opener}»` : '',
          ].filter(Boolean).join(' ')
          const mailPrompt = pickPrompt(s, s.typeWeights, goalCtx + agentCtx)
          const gen = await generateComment(openerTask, mailPrompt.index, mailPrompt.sys, account)
          if (gen?.usage?.tokens) await recordTokens({ ...gen.usage, module: task.moduleKey, accountId: account, taskId: task.id, campaignId: s.campaignId, userId: task.userId })
          // Чистим так же, как в диалогах: модель повторяет ярлыки промпта и оставляет
          // заготовки. С заглушкой лучше отправить текст из цели, чем «[тут вставь ссылку]».
          const cleaned = cleanDialogReply(gen.text)
          if (cleaned && !hasPlaceholder(cleaned)) text = cleaned
          else if (cleaned) await store.appendLog(task, 'warning', `${label}: ИИ оставил заготовку — отправляем текст из цели`, meta.name)
        }
        // 3) Пауза «по-человечески» и отправка (#6: прерываемая — стоп не шлёт лишнее ЛС).
        const dmWait = pickDelay(dm[0], dm[1], mul) * 1000
        await noteWait(task, store, dmWait, 'задержка перед отправкой ЛС', meta.name)
        if (await interruptibleSleep(dmWait, makeStopCheck(store, task.id))) { await disconnectAccount(client, account); break }
        await sendComposedMessage(client, user, text, s.mediaUrls) // §11: текст + медиа/ссылки
        // §11.1: исходящее ЛС — под контролем владельца (рассылка чужим людям
        // рискованнее всего, поэтому её текст видеть важнее прочего).
        void recordMessage({ accountId: account, peer: String(tgt || user?.username || ''), direction: 'out', text, userId: task.userId, moduleKey: task.moduleKey, taskId: task.id, campaignId: s.campaignId })
        await incAction(account, 'dm') // §6: суточный лимит ЛС
        // Не засоряем адресную книгу аккаунта импортированными номерами.
        try { await client.invoke(new Api.contacts.DeleteContacts({ id: [user] })) } catch { /* не критично */ }
        perAccSent[account] = (perAccSent[account] || 0) + 1
        sent += 1
        task.accountStats[account] = task.accountStats[account] || { actions: 0, floodWaits: 0 }
        task.accountStats[account].actions += 1
        task.progress.done = sent + skipped
        // `peer` — то, как человек виден в Telegram: по нему потом открывается переписка
        // (сама цель могла быть номером, а лид живёт под юзернеймом).
        await store.appendHistory(task, {
          id: `${task.id}_${Date.now()}`,
          ts: new Date().toISOString(),
          accountId: account,
          accountName: meta.name || account,
          target: label,
          peer: user.username ? `@${user.username}` : label,
          text,
          status: 'sent',
        })
        // §9: лид сразу в CRM со статусом «холодный» — это знаменатель конверсии
        // (скольким написали). Ответит — авто-ответчик продвинет его по воронке.
        // peer берём как @username (по нему матчатся входящие диалоги), иначе — телефон.
        if (s.goalId || s.campaignId) {
          try {
            await upsertLead({
              userId: task.userId,
              peer: user.username ? `@${user.username}` : label,
              goalId: s.goalId,
              campaignId: s.campaignId,
              taskId: task.id,
              accountId: account,
              status: 'cold',
            })
          } catch (e) { await store.appendLog(task, 'warning', `Лид не записан: ${e instanceof Error ? e.message : e}`, meta.name) }
        }
        await store.appendLog(task, 'success', `ЛС → ${label} (${user.firstName || 'user'})`, meta.name)
        await bumpProgress(task, store)
        await noteAction(account) // §4.3: усталость общая для всех модулей
        await disconnectAccount(client, account)
      } catch (err) {
        if (client) await disconnectAccount(client, account)
        else endAccountWork(account, task.id) // подключение сорвалось — слот занятости не держим
        const reason = mapTelegramError(err)
        const виноватАккаунт = await handleFlood(task, account, store, err, s, meta.name)
        if (!виноватАккаунт) {
          await store.appendLog(task, 'error', reason, meta.name)
        }
        // Аккаунт выбыл (спамблок/флуд/бан), а цель ни при чём — отдаём её другому.
        const ключЦели = `${tgt.kind}:${tgt.value}`
        if (виноватАккаунт && myAccounts.length > 1 && !повторено.has(ключЦели)) {
          повторено.add(ключЦели)
          очередь.push(tgt)
          await store.appendLog(task, 'info', `${label}: аккаунт выбыл — цель вернулась в очередь, напишет другой`, meta.name)
          continue
        }
        // Ошибка по конкретному человеку — тоже часть ответа «кому не написали».
        // Такие цели в следующую рассылку брать МОЖНО: причина в аккаунте, не в них.
        await store.appendHistory(task, {
          id: `${task.id}_${Date.now()}`,
          ts: new Date().toISOString(),
          accountId: account,
          accountName: meta.name || account,
          target: label,
          text: '',
          status: 'failed',
          reason,
        })
      }
    }
    }

    // §3.9: потоки рассылки. Цели и аккаунты делятся между ними, работают
    // одновременно — но это ОДНА задача: один прогресс, одни логи, один «Стоп».
    const threads = Math.max(1, Math.min(Number(s.threads) || 1, usable.length))
    if (threads > 1) {
      const tGroups = Array.from({ length: threads }, () => [])
      const aGroups = Array.from({ length: threads }, () => [])
      mailTargets.forEach((t, i) => tGroups[i % threads].push(t))
      usable.forEach((a, i) => aGroups[i % threads].push(a))
      await store.appendLog(task, 'info', `Асинхронная рассылка: ${threads} поток(ов), аккаунтов ${usable.length}, целей ${mailTargets.length}`)
      await Promise.all(tGroups.map((g, i) => (g.length && aGroups[i].length ? runThread(g, aGroups[i], i) : Promise.resolve())))
    } else {
      await runThread(mailTargets, usable, 0)
    }
    task.status = statusAfterRun(task)
    await store.appendLog(task, 'info', `Мейлинг завершён · отправлено ${sent} · пропущено ${skipped} (нет в Telegram)`)
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
}

/** Ошибки Telegram, где подсказка про права админа действительно уместна. */
const ADMIN_RIGHTS_ERRORS = /CHAT_ADMIN_REQUIRED|CHAT_WRITE_FORBIDDEN|CHAT_SEND_.*FORBIDDEN|USER_BANNED_IN_CHANNEL/i

/**
 * Текст ошибки постинга. Подсказку «нужны права админа» дописываем ТОЛЬКО к ошибкам
 * доступа: раньше она приклеивалась к любой, включая сетевые и прокси
 * (`Invalid sockets params: socksType=undefined`), и уводила оператора проверять права,
 * когда дело было в прокси (прогон 21–22.07, тест 10.1).
 * @param {unknown} err
 */
export function postErrorHint(err) {
  const msg = mapTelegramError(err)
  const raw = err instanceof Error ? `${err.message} ${msg}` : String(msg)
  return ADMIN_RIGHTS_ERRORS.test(raw) ? `${msg} — аккаунт должен быть админом канала с правом публикации` : msg
}

/**
 * Автопостинг (§8.10, паритет): публикация поста в СВОИ каналы/группы по расписанию.
 * Безопасно — постим в свои каналы (аккаунт должен быть админом с правом постинга), не спам.
 * @param {object} task @param {object} store
 */
export async function runAutoPosting(task, store) {
  const s = task.settings || {}
  const accountIds = Array.isArray(s.accountIds) ? s.accountIds : []
  const channels = targets(s)
  const text = String(s.promptText || s.message || '').trim()

  task.status = 'running'
  task.progress = { done: 0, total: channels.length }
  await store.saveTask(task)
  await store.appendLog(task, 'info', `Автопостинг: ${channels.length} каналов · ${accountIds.length} аккаунт(ов)`)

  if (!channels.length) { await store.appendLog(task, 'warning', 'Нет целевых каналов'); task.status = 'done'; await store.saveTask(task); return }
  if (!accountIds.length) { await store.appendLog(task, 'warning', 'Не выбраны аккаунты'); task.status = 'done'; await store.saveTask(task); return }
  if (!text) { await store.appendLog(task, 'warning', 'Пустой текст поста'); task.status = 'done'; await store.saveTask(task); return }

  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const { resolvePeer } = await import('../lib/gramHelpers.js')
  let accIdx = 0
  try {
    for (const ch of channels) {
      if (task.stopRequested || task.pauseRequested) break
      // Канал закрепляем не за первым попавшимся аккаунтом, а за первым ПРИГОДНЫМ:
      // раньше недоступный аккаунт уносил с собой сам канал (`continue` шёл по каналам,
      // а не по аккаунтам) — пост не публиковался и никому не передавался, задача
      // заканчивалась с «0 из N» и ошибкой (аудит 20.08).
      let accountId = null
      let meta = null
      for (let tried = 0; tried < accountIds.length; tried++) {
        const cand = accountIds[accIdx++ % accountIds.length]
        const cm = await accountMeta(cand)
        if (!canModuleUseAccount(task.moduleKey, cm.status || 'active')) {
          await store.appendLog(task, 'info', `Пропуск: статус ${cm.status}`, cm.name || cand)
          continue
        }
        accountId = cand
        meta = cm
        break
      }
      if (!accountId) { await store.appendLog(task, 'warning', `${ch}: нет доступных аккаунтов для публикации`); continue }
      let client
      try {
        ;({ client } = await connectAccount(accountId, task.id, { shouldStop: stopFlag(task) }))
        const entity = await resolvePeer(client, ch)
        await sendComposedMessage(client, entity, text, s.mediaUrls) // §11: текст + медиа/ссылки
        task.history = task.history || []
        task.history.unshift({ id: `${task.id}_${task.progress.done}`, ts: new Date().toISOString(), accountName: meta.name, channel: ch, text: text.slice(0, 200), status: 'sent' })
        task.progress.done += 1
        await store.appendLog(task, 'success', `Пост в ${ch}`, meta.name)
        await store.saveTask(task)
        await disconnectAccount(client, accountId)
        const postWait = pickDelay(s.delays?.action?.[0] ?? 60, s.delays?.action?.[1] ?? 180, mul) * 1000
        await noteWait(task, store, postWait, 'задержка между публикациями', meta.name)
        if (await breakableDelay(postWait, store, task)) break
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        else endAccountWork(accountId, task.id) // подключение сорвалось — слот занятости не держим
        if (!(await handleFlood(task, accountId, store, err, s, meta.name))) {
          await store.appendLog(task, 'error', `${ch}: ${postErrorHint(err)}`, meta.name)
        }
      }
      task = (await store.loadTask(task.id)) || task
    }
    task.status = statusAfterRun(task)
    // §8.4: запуск, не опубликовавший НИ ОДНОГО поста, — это не «Готово».
    // Раньше здесь всегда стоял statusAfterRun → задача с 0/1 показывалась как успешная,
    // и провал был виден только тому, кто откроет логи (прогон 21–22.07, тест 10.1).
    if (task.status === 'done' && task.progress.done === 0 && task.progress.total > 0) {
      task.status = 'error'
      await store.appendLog(task, 'error', `Не опубликовано ни одного поста из ${task.progress.total} — см. ошибки выше`)
    } else {
      await store.appendLog(task, 'info', 'Автопостинг завершён')
    }
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
}

export const WORKERS = {
  mailing: runMailing,
  autoposting: runAutoPosting,
  'neuro-commenting': runNeuroCommenting,
  'neuro-chatting': runNeuroChatting,
  'mass-react': runMassReact,
  'mass-looking': runMassLooking,
  warming: runWarming,
  'neuro-dialogs': runNeuroDialogs,
  ggr: runGgr,
  parsing: (t, s) => runChannelParser(t, s, 'parsing'),
  'parsing-groups': (t, s) => runChannelParser(t, s, 'parsing-groups'),
  'parsing-users': (t, s) => runParticipantsParser(t, s, 'parsing-users'),
  'parsing-messages': (t, s) => runParticipantsParser(t, s, 'parsing-messages'),
  'parsing-comments': (t, s) => runParticipantsParser(t, s, 'parsing-comments'),
  'spam-unblock': runSpamUnblock,
}
