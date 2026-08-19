import { loadSessionString, createClient } from '../tgAuth.js'
import { getAccountMeta, setAccountMeta, setAccountStatus } from '../accountsMeta.js'
import { isAccountRunnable, extractFloodSeconds, sleep } from './protection.js'
import { assertAccountAvailable } from './accountLocks.js'
import { resolveDurationPeriodMinutes } from './workModeDuration.js'
import { getAiSafetySync } from '../aiSafety.js'
import { resolvePerAccountTarget, resolveTotalTarget } from './targets.js'
import { accountFingerprint } from './deviceFingerprint.js'

/**
 * Реестр живых клиентов по задачам: taskId → Set<client>. Нужен, чтобы «Стоп»/«Пауза»
 * могли ПРИНУДИТЕЛЬНО оборвать соединение аккаунта. Сетевые вызовы gram (searchPublic,
 * fetchPosts, sendReaction…) не имеют таймаута и не проверяют флаг стопа: на медленном
 * прокси они висят десятки секунд, и «Стоп» игнорировался всё это время. При обрыве
 * соединения такой вызов сразу падает → воркер попадает в catch → видит стоп → выходит.
 * @type {Map<string, Set<import('telegram').TelegramClient>>}
 */
const taskClients = new Map()

/** Прервать все живые соединения задачи — зависшие gram-вызовы упадут, воркер выйдет по стопу. */
export async function abortTaskClients(taskId) {
  const set = taskClients.get(taskId)
  if (!set || !set.size) return 0
  const clients = [...set]
  taskClients.delete(taskId)
  for (const c of clients) {
    // Взводим флаг аборта — обёртка invoke (см. wrapInvoke) отклонит ЛЮБОЙ висящий
    // RPC-вызов за ~0.25с. disconnect() сам по себе pending-вызов gram НЕ отклоняет.
    c.__aborted = true
    // Не ждём disconnect дольше 2с — на битом соединении он сам может подвиснуть.
    try { await Promise.race([Promise.resolve().then(() => c.disconnect()).catch(() => {}), sleep(2000)]) } catch { /* ignore */ }
  }
  return clients.length
}

/** @param {string} accountId @param {string} [taskId] */
export async function connectAccount(accountId, taskId) {
  assertAccountAvailable(accountId, taskId)
  const meta = await getAccountMeta(accountId)
  if (!isAccountRunnable(meta.status || 'active')) {
    throw new Error(`ACCOUNT_SKIP:${meta.status}`)
  }
  const sessionStr = await loadSessionString(accountId)
  if (!sessionStr) {
    await setStatus(accountId, 'reauth', { code: 'NO_SESSION', reason: 'Нет сессии — нужна переавторизация', task: { id: taskId } })
    throw new Error('NO_SESSION')
  }
  // Запоминаем, из какого статуса аккаунт ушёл в работу. Без этого disconnect
  // возвращал жёстко 'active' и стирал 'warming' — аккаунт, который прогревается,
  // после первого же действия становился обычным активным (тест 12.5).
  await setAccountMeta(accountId, { status: 'working', statusBefore: meta.status || 'active' })
  // invoke уже обёрнут в createClient (жёсткий лимит RPC + флаг __aborted) — предел
  // действует и здесь, и в карточке аккаунта, и в каналах.
  let client
  try {
    client = await createClient(sessionStr, meta.proxy, accountFingerprint(accountId, meta))
  } catch (err) {
    // Прокси подвёл в БОЮ — помечаем нерабочим сразу, а не ждём получасовой авто-проверки:
    // иначе следующая задача снова возьмёт этот прокси и снова встанет на таймаутах.
    const msg = String(err?.message || '')
    if (meta.proxy && meta.proxy !== '—' && !/AUTH_KEY|SESSION_REVOKED/i.test(msg)) {
      try {
        const { markProxyStatusByUrl } = await import('../proxies.js')
        await markProxyStatusByUrl(meta.proxy, 'dead')
      } catch { /* non-fatal */ }
      try { await setAccountMeta(accountId, { proxyWorking: false, proxyCheckAt: Date.now() }) } catch { /* non-fatal */ }
    }
    // Аккаунт из 'working' надо вернуть — статус ему выставили ДО подключения.
    try { await setAccountMeta(accountId, { status: meta.status || 'active', statusBefore: null }) } catch { /* non-fatal */ }
    throw err
  }
  // Регистрируем клиент под задачей — чтобы стоп/пауза могли его оборвать (см. abortTaskClients).
  if (taskId) {
    client.__taskId = taskId
    let set = taskClients.get(taskId)
    if (!set) { set = new Set(); taskClients.set(taskId, set) }
    set.add(client)
  }
  return { client, meta }
}

/** @param {import('telegram').TelegramClient} client @param {string} accountId */
export async function disconnectAccount(client, accountId) {
  // Снимаем из реестра задачи (если был зарегистрирован при connectAccount).
  const taskId = client?.__taskId
  if (taskId) { const set = taskClients.get(taskId); if (set) { set.delete(client); if (!set.size) taskClients.delete(taskId) } }
  try {
    await client.disconnect()
  } catch {
    /* ignore */
  }
  const meta = await getAccountMeta(accountId)
  // Возвращаем аккаунт в тот статус, из которого он ушёл в работу: 'warming' должен
  // пережить действие, иначе прогрев снимается сам собой после первого же шага.
  if (meta.status === 'working') {
    const back = meta.statusBefore === 'warming' ? 'warming' : 'active'
    await setAccountMeta(accountId, { status: back, statusBefore: null })
  }
}

/**
 * Сменить статус аккаунта через state machine + аудит (§4). Не роняет воркер:
 * при недопустимом переходе падаем на прямую запись meta (совместимость).
 * @param {string} accountId @param {string} to @param {{ code?: string, reason?: string, until?: number|null, task?: object }} [opts]
 */
async function setStatus(accountId, to, opts = {}) {
  try {
    await setAccountStatus(accountId, to, {
      code: opts.code,
      reason: opts.reason,
      until: opts.until ?? null,
      initiator: 'system',
      module: opts.task?.moduleKey,
      taskId: opts.task?.id,
    })
  } catch (err) {
    // Недопустимый переход или сбой — не роняем воркер, но не молчим (аудит-пробел виден).
    console.warn(`[status] setAccountStatus(${accountId.slice(-6)}→${to}) fallback:`, err?.message || err)
    await setAccountMeta(accountId, { status: to })
  }
}

/**
 * Обработка ошибки аккаунта: FloodWait + политики ИИ-безопасности (feature 11).
 * Возвращает true, если ошибка «обработана» (генерик-лог в воркере не нужен).
 * @param {object} task @param {string} accountId @param {object} store @param {unknown} err @param {object} settings
 */
export async function handleFlood(task, accountId, store, err, settings, accountName) {
  const safety = getAiSafetySync()
  const floodSec = extractFloodSeconds(err)
  if (floodSec > 0) {
    task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
    task.accountStats[accountId].floodWaits += 1
    const fwDelay = floodSec + (settings.delays?.floodWait ?? safety.floodWaitExtraSeconds ?? 120)
    await store.appendLog(task, 'warning', `FloodWait ${floodSec}с — пауза ${fwDelay}с`, accountName)
    // Явный статус floodwait с длительностью (§3.3): аккаунт на паузу, никто по нему не работает.
    await setStatus(accountId, 'floodwait', { code: `FLOOD_WAIT_${floodSec}`, reason: `FloodWait ${floodSec}с`, until: Date.now() + fwDelay * 1000, task })
    await sleep(fwDelay * 1000)
    const limit = settings.delays?.floodQuarantine ?? safety.floodQuarantineThreshold ?? 3
    if (task.accountStats[accountId].floodWaits >= limit) {
      await setStatus(accountId, 'quarantine', { code: 'FLOOD_QUARANTINE', reason: `Карантин после ${limit} FloodWait`, task })
      await store.appendLog(task, 'error', `Карантин после ${limit} FloodWait`, accountName)
    } else {
      // Пауза выждана — возвращаем в работу.
      await setStatus(accountId, 'active', { code: 'FLOOD_CLEARED', reason: 'FloodWait истёк — возврат в работу', task })
    }
    await store.saveTask(task)
    return true
  }
  return applyBanPolicy(task, accountId, store, err, accountName)
}

/**
 * Политики на бан/спамблок из ИИ-безопасности (feature 11).
 * Дефолт onBan='continue' сохраняет прежнее поведение (просто лог ошибки в воркере).
 * @param {object} task @param {string} accountId @param {object} store @param {unknown} err @param {string} [accountName]
 */
export async function applyBanPolicy(task, accountId, store, err, accountName) {
  const msg = `${/** @type {any} */ (err)?.errorMessage || /** @type {any} */ (err)?.message || ''}`
  // USER_BANNED_IN_CHANNEL — запрет писать в КОНКРЕТНОМ чате: аккаунта это не касается,
  // он жив и работает везде остальном. Раньше он попадал под общее правило бана, и при
  // политике «карантин» один строгий чат выводил здоровый аккаунт из работы целиком —
  // на парке в сотни профилей так выкашивается половина пула из-за пары чатов.
  const bannedHere = /USER_BANNED_IN_CHANNEL/i.test(msg)
  const isBan = !bannedHere && /USER_BANNED|USER_DEACTIVATED|BANNED|AUTH_KEY|ACCOUNT_.*BAN/i.test(msg)
  const isSpam = /SPAM|PEER_FLOOD/i.test(msg)
  if (!isBan && !isSpam) return false
  const safety = getAiSafetySync()

  if (isSpam) {
    if (safety.onSpamblock === 'quarantine') {
      await setStatus(accountId, 'quarantine', { code: 'SPAM', reason: 'Спамблок → карантин аккаунта', task })
      await store.appendLog(task, 'error', 'Спамблок → карантин аккаунта', accountName)
      await store.saveTask(task)
      return true
    }
    // Со сроком: без него аккаунт залипал в spamblock навсегда и не возвращался в работу
    // сам. Telegram точную длительность не сообщает — берём сутки, это типичный срок
    // первого спамблока; `reconcileExpiredStatuses` вернёт аккаунт в active по истечении.
    const until = Date.now() + (safety.spamblockHours ?? 24) * 3600 * 1000
    await setStatus(accountId, 'spamblock', { code: 'SPAM', reason: 'Спамблок — аккаунт помечен и пропускается', until, task })
    await store.appendLog(task, 'warning', `Спамблок — аккаунт выведен до ${new Date(until).toLocaleString('ru-RU')}`, accountName)
    await store.saveTask(task)
    return true
  }

  switch (safety.onBan) {
    case 'quarantine':
      await setStatus(accountId, 'quarantine', { code: 'BAN', reason: 'Бан → карантин аккаунта (политика ИИ-безопасности)', task })
      await store.appendLog(task, 'error', 'Бан → карантин аккаунта (политика ИИ-безопасности)', accountName)
      await store.saveTask(task)
      return true
    case 'stop-account':
      await setStatus(accountId, 'invalid', { code: 'BAN', reason: 'Бан → аккаунт остановлен (политика ИИ-безопасности)', task })
      await store.appendLog(task, 'error', 'Бан → аккаунт остановлен (политика ИИ-безопасности)', accountName)
      await store.saveTask(task)
      return true
    case 'stop-task':
      task.stopRequested = true
      await setStatus(accountId, 'invalid', { code: 'BAN', reason: 'Бан → задача остановлена (политика ИИ-безопасности)', task })
      await store.appendLog(task, 'error', 'Бан → задача остановлена (политика ИИ-безопасности)', accountName)
      await store.saveTask(task)
      return true
    default:
      return false
  }
}

/** @param {object} settings @param {string} accountId */
export function perAccountLimitReached(settings, accountId, task) {
  // Суточный кап из ИИ-безопасности (мягкое ограничение на уровне задачи).
  const dailyCap = getAiSafetySync().perAccountDailyCap || 0
  const done = task.accountStats?.[accountId]?.actions ?? 0
  if (dailyCap > 0 && done >= dailyCap) return true

  const target = resolvePerAccountTarget(settings, accountId, task)
  if (!target) return false
  return done >= target
}

/** @param {object} settings */
export function totalLimitReached(settings, task) {
  const target = resolveTotalTarget(settings, task)
  if (settings.workMode === 1 && settings.durationMinutes) {
    const period = resolveDurationPeriodMinutes(settings, { taskId: task.id, startedAt: task.startedAt })
    if (!period) return false
    const endAt = task.startedAt + period.chosen * 60_000
    if (Date.now() >= endAt) return true
  }
  if (settings.workMode === 1 && !settings.durationMinutes) return false
  return (task.progress?.actionsDone ?? task.progress?.commentsSent ?? 0) >= target
}
